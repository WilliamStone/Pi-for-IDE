// embed 模式的「轮次快照」登记器。
//
// 宿主在每轮 prompt 发出前为该轮文件改动建快照（用于文件审查/回退）。
// 快照标识 turnId 由前端生成；pi 返回真实 user message entryId 后，两者
// 在本类中配对，FileReviewCard/回退逻辑凭 entryId 反查 turnId。

import { isEmbedMode, captureSnapshotViaHost } from "./bridge";

export class TurnSnapshotTracker {
  /** 本轮发 prompt 前生成的 turnId，等 pi 返回真实 entryId 后配对。 */
  private pendingTurnId: string | null = null;
  /** user message entryId → 本轮 turnId。 */
  private entryIdToTurnId = new Map<string, string>();

  /**
   * 发 prompt 前调用：向宿主建本轮文件快照并登记 pendingTurnId。
   * 必须同步等快照建完再发 prompt，否则 agent 可能已改文件、before 不准。
   * 快照失败不阻断发消息（只是本轮回退不可用）。非 embed 模式或无 cwd
   * 时为空操作。
   */
  async capture(cwd: string | null | undefined): Promise<void> {
    if (!isEmbedMode() || !cwd) return;
    const turnId = crypto.randomUUID?.() ?? `turn-${Date.now()}`;
    try {
      await captureSnapshotViaHost(turnId, cwd);
    } catch {
      // 快照失败不阻断发消息，只是本轮回退按钮会不可用。
    }
    this.pendingTurnId = turnId;
  }

  /**
   * session context 加载后调用：entryIds 和 messages 是平行数组，把
   * pendingTurnId 配对到最后一条 user message 的真实 entryId。
   */
  pairWithLastUserEntry(
    messages: readonly { role: string }[],
    entryIds: string[] | undefined,
  ): void {
    const pendingTurnId = this.pendingTurnId;
    if (!pendingTurnId || !entryIds) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        const eid = entryIds[i];
        if (eid) {
          this.entryIdToTurnId.set(eid, pendingTurnId);
          this.pendingTurnId = null;
        }
        break;
      }
    }
  }

  /** 查某 user message entryId 对应的本轮 turnId；无配对时回退为入参本身。 */
  turnIdForEntry(entryId: string): string {
    return this.entryIdToTurnId.get(entryId) ?? entryId;
  }
}
