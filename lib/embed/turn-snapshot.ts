// embed 模式的「轮次快照」登记器。
//
// 宿主在每轮 prompt 发出前为该轮文件改动建快照（用于文件审查/回退）。
// 快照标识 turnId 由前端生成；pi 返回真实 user message entryId 后，两者
// 在本类中配对，FileReviewCard/回退逻辑凭 entryId 反查 turnId。

// 显式 .ts 后缀：Next bundler 与 node --experimental-strip-types 测试环境
// 都能解析（后者对 ESM 格式 .ts 文件不做扩展名猜测）。
import { isEmbedMode, captureSnapshotViaHost } from "./bridge.ts";

/** entryId→turnId 配对存活期：页面 reload 后 map 丢失会导致回退全灭，
 *  用 sessionStorage 把配对存下来（同源 iframe 内有效，随 tab 关闭清空）。 */
const STORAGE_KEY = "pi-web.turnSnapshots";

export class TurnSnapshotTracker {
  /** 本轮发 prompt 前生成的 turnId，等 pi 返回真实 entryId 后配对。 */
  private pendingTurnId: string | null = null;
  /** user message entryId → 本轮 turnId。 */
  private entryIdToTurnId = new Map<string, string>();

  constructor() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        for (const [k, v] of JSON.parse(raw) as [string, string][]) {
          this.entryIdToTurnId.set(k, v);
        }
      }
    } catch {
      // sessionStorage 不可用时配对退化到内存——行为与之前一致。
    }
  }

  private persist(): void {
    try {
      // 上限 500：同一 tab 里开过很多会话后配对表会膨胀，按插入序丢最老。
      while (this.entryIdToTurnId.size > 500) {
        const oldest = this.entryIdToTurnId.keys().next().value;
        if (oldest === undefined) break;
        this.entryIdToTurnId.delete(oldest);
      }
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...this.entryIdToTurnId]));
    } catch {
      // 同 constructor 的静默降级。
    }
  }

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
          this.persist();
        }
        break;
      }
    }
  }

  /** 某 user message entryId 是否有已配对的 turnId（宿主快照可能还在）。 */
  hasSnapshotFor(entryId: string): boolean {
    return this.entryIdToTurnId.has(entryId);
  }

  /** 查某 user message entryId 对应的本轮 turnId；无配对时回退为入参本身。 */
  turnIdForEntry(entryId: string): string {
    return this.entryIdToTurnId.get(entryId) ?? entryId;
  }
}
