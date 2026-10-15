/** Handles protrude 5px; resize controls protrude 6px on each body. */
export const NODE_PAINT_OUTSET = 6
export const NODE_PAINT_GAP = 2
export const NODE_COLLISION_CLEARANCE = NODE_PAINT_OUTSET * 2 + NODE_PAINT_GAP
// Subpixel arithmetic noise is far below a rendered CSS pixel.
export const COLLISION_EPSILON = 1e-7
export const GROUP_HEADER_HEIGHT = 44
export const GROUP_HEADER_GAP = 4
/** Stable world-space display projection; never writes canonical positions. */
export interface CollisionRect {
  id: string
  x: number
  y: number
  width: number
  height: number
  pinned?: boolean
}
export type CollisionProjection =
  | { ok: true; positions: Map<string, { x: number; y: number }>; changed: boolean }
  | { ok: false; code: 'layout-collision-unresolved'; nodeIds: string[] }
export function rectanglesOverlap(
  a: Pick<CollisionRect, 'x' | 'y' | 'width' | 'height'>,
  b: Pick<CollisionRect, 'x' | 'y' | 'width' | 'height'>,
  clearance = NODE_COLLISION_CLEARANCE
): boolean {
  return (
    a.x < b.x + b.width + clearance - COLLISION_EPSILON &&
    a.x + a.width + clearance > b.x + COLLISION_EPSILON &&
    a.y < b.y + b.height + clearance - COLLISION_EPSILON &&
    a.y + a.height + clearance > b.y + COLLISION_EPSILON
  )
}
export function projectLayoutCollisions(rects: readonly CollisionRect[], rigidGroups: readonly (readonly string[])[] = []): CollisionProjection {
  const byId = new Map(rects.map(rect => [rect.id, rect]))
  const groups: CollisionRect[][] = []
  const assigned = new Set<string>()
  for (const ids of rigidGroups) {
    const members = ids.flatMap(id => (byId.has(id) && !assigned.has(id) ? [byId.get(id)!] : []))
    const internal = members.flatMap((rect, index) =>
      members
        .slice(index + 1)
        .filter(other => rectanglesOverlap(rect, other))
        .flatMap(other => [rect.id, other.id])
    )
    if (internal.length)
      return {
        ok: false,
        code: 'layout-collision-unresolved',
        nodeIds: [...new Set(internal)].sort()
      }
    members.forEach(rect => assigned.add(rect.id))
    if (members.length) groups.push(members)
  }
  for (const rect of rects) if (!assigned.has(rect.id)) groups.push([rect])
  groups.sort(
    (a, b) =>
      Number(b.some(r => r.pinned)) - Number(a.some(r => r.pinned)) ||
      Math.min(...a.map(r => r.y)) - Math.min(...b.map(r => r.y)) ||
      Math.min(...a.map(r => r.x)) - Math.min(...b.map(r => r.x)) ||
      a
        .map(r => r.id)
        .sort()
        .join(',')
        .localeCompare(
          b
            .map(r => r.id)
            .sort()
            .join(',')
        )
  )
  const placed: CollisionRect[] = [],
    positions = new Map<string, { x: number; y: number }>()
  let changed = false
  for (const members of groups) {
    let dy = 0
    for (;;) {
      const clashes = members.flatMap(rect => placed.filter(other => rectanglesOverlap({ ...rect, y: rect.y + dy }, other)).map(other => ({ rect, other })))
      if (!clashes.length) break
      if (members.some(rect => rect.pinned))
        return {
          ok: false,
          code: 'layout-collision-unresolved',
          nodeIds: [...new Set([...members.map(r => r.id), ...clashes.map(c => c.other.id)])].sort()
        }
      dy = Math.max(...clashes.map(({ rect, other }) => other.y + other.height + NODE_COLLISION_CLEARANCE - rect.y))
    }
    for (const rect of members) {
      const position = { x: rect.x, y: rect.y + dy }
      positions.set(rect.id, position)
      placed.push({ ...rect, ...position })
      changed ||= dy !== 0
    }
  }
  return { ok: true, positions, changed }
}
/** Headers are independent display obstacles, including intersecting set-groups. */
export function avoidGroupHeaders<
  T extends {
    id: string
    x: number
    y: number
    width: number
    height: number
    nodeIds?: readonly string[]
  }
>(frames: readonly T[], bodies: readonly CollisionRect[]): T[] {
  const placed: Array<{ x: number; y: number; width: number; height: number }> = []
  const result = new Map<string, T>()
  for (const frame of [...frames].sort((a, b) => (a.nodeIds?.length ?? 0) - (b.nodeIds?.length ?? 0) || a.id.localeCompare(b.id))) {
    let y = frame.y
    for (;;) {
      const header = { x: frame.x, y, width: frame.width, height: GROUP_HEADER_HEIGHT }
      const blockers = [...bodies, ...placed].filter(other => rectanglesOverlap(header, other, 0))
      if (!blockers.length) break
      y = Math.min(...blockers.map(other => other.y)) - GROUP_HEADER_HEIGHT - GROUP_HEADER_GAP
    }
    placed.push({ x: frame.x, y, width: frame.width, height: GROUP_HEADER_HEIGHT })
    result.set(frame.id, { ...frame, y, height: frame.height + frame.y - y })
  }
  return frames.map(frame => result.get(frame.id)!)
}
