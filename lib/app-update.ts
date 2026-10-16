// 版本号形如 0.12.1 或 0.12.1-3（上游 base + 本仓迭代序号）。
const STABLE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/;

function parseStableVersion(version: string): [number, number, number, number | null] | null {
  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match) return null;

  const parts = match.slice(1).map((part) => (part === undefined ? null : Number(part)));
  if (parts.slice(0, 3).some((part) => !Number.isSafeInteger(part))) return null;
  if (parts[3] !== null && !Number.isSafeInteger(parts[3])) return null;
  return parts as [number, number, number, number | null];
}

export function isNewerStableVersion(candidate: string, current: string): boolean {
  const candidateParts = parseStableVersion(candidate);
  const currentParts = parseStableVersion(current);
  if (!candidateParts || !currentParts) return false;

  for (let index = 0; index < 3; index += 1) {
    const candidatePart = candidateParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (candidatePart !== currentPart) {
      return candidatePart > currentPart;
    }
  }
  // 同 base：正式版 > 序号版；同有序号时比序号。
  if (candidateParts[3] === null) return currentParts[3] !== null;
  if (currentParts[3] === null) return false;
  return candidateParts[3] > currentParts[3];
}

export function getPiWebReleaseUrl(version: string): string | null {
  if (!parseStableVersion(version)) return null;
  return `https://github.com/WilliamStone/Pi-for-IDE/releases/tag/v${version}`;
}
