import type {LocatedMgTag, MgInstanceInfo, MgVideoInfo} from "./types.js";

export type MgFrameWindow = {startFrame: number; endFrame: number};

/** Fill only the narration pause between text-adjacent direct siblings.
 * Include later segments of the same split instance; descendants are not siblings.
 */
const adjacentSiblingStart = (
  tag: LocatedMgTag,
  instances: ReadonlyMap<string, MgInstanceInfo>,
): number | undefined => {
  const next = [...instances.values()].flatMap((instance) => instance.tags)
    .filter((candidate) => candidate.parentInstance === tag.parentInstance
      && candidate.depth === tag.depth && candidate.documentOrder > tag.documentOrder)
    .sort((a, b) => a.documentOrder - b.documentOrder)[0];
  if (!next) return undefined;
  const hasOffsets = (value: LocatedMgTag) =>
    Number.isInteger(value.startOffset) && Number.isInteger(value.endOffset);
  const adjacent = hasOffsets(tag) && hasOffsets(next)
    ? next.startOffset === tag.endOffset
    : Math.abs(next.start - tag.end) <= 0.001;
  return adjacent ? next.start : undefined;
};

/** One start/end rule for every MG tag and every existing together/split window.
 * Animation metadata cannot extend the reviewed annotation's hard boundary.
 * Parent clipping and split organization remain the caller's responsibility.
 */
export const getMgAnnotationWindow = (
  tags: readonly LocatedMgTag[],
  instances: ReadonlyMap<string, MgInstanceInfo>,
  video: MgVideoInfo,
): MgFrameWindow => {
  if (!tags.length) throw new Error("MG window requires at least one annotated tag");
  if (!Number.isFinite(video.fps) || video.fps <= 0 || video.durationFrames < 1) {
    throw new Error("MG window requires a valid episode frame range");
  }
  const first = tags[0];
  const last = tags.at(-1)!;
  const end = adjacentSiblingStart(last, instances) ?? last.end;
  if (!Number.isFinite(first.start) || !Number.isFinite(end) || end < first.start) {
    throw new Error(`${first.instanceKey} has invalid annotation timestamps`);
  }
  const startFrame = Math.max(0, Math.min(video.durationFrames - 1, Math.round(first.start * video.fps)));
  const endFrame = Math.min(video.durationFrames, Math.max(startFrame + 1, Math.round(end * video.fps)));
  return {startFrame, endFrame};
};
