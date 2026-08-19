export interface CanvasRectangle {
  height: number;
  id: string;
  width: number;
  x: number;
  y: number;
}

export const defaultCanvasNodeGap = 36;

function rectanglesOverlap(
  left: CanvasRectangle,
  right: CanvasRectangle,
  gap: number,
): boolean {
  return (
    left.x < right.x + right.width + gap &&
    left.x + left.width + gap > right.x &&
    left.y < right.y + right.height + gap &&
    left.y + left.height + gap > right.y
  );
}

function nearestAvailablePosition(
  node: CanvasRectangle,
  obstacles: readonly CanvasRectangle[],
  source: CanvasRectangle,
  gap: number,
): { x: number; y: number } {
  const candidates: Array<{ x: number; y: number }> = [
    { x: node.x, y: node.y },
  ];
  for (const obstacle of obstacles) {
    candidates.push(
      { x: obstacle.x - node.width - gap, y: node.y },
      { x: obstacle.x + obstacle.width + gap, y: node.y },
      { x: node.x, y: obstacle.y - node.height - gap },
      { x: node.x, y: obstacle.y + obstacle.height + gap },
    );
  }
  if (obstacles.length > 0) {
    candidates.push(
      {
        x:
          Math.min(...obstacles.map((obstacle) => obstacle.x)) -
          node.width -
          gap,
        y: node.y,
      },
      {
        x: Math.max(
          ...obstacles.map(
            (obstacle) => obstacle.x + obstacle.width + gap,
          ),
        ),
        y: node.y,
      },
      {
        x: node.x,
        y:
          Math.min(...obstacles.map((obstacle) => obstacle.y)) -
          node.height -
          gap,
      },
      {
        x: node.x,
        y: Math.max(
          ...obstacles.map(
            (obstacle) => obstacle.y + obstacle.height + gap,
          ),
        ),
      },
    );
  }

  const sourceCenter = {
    x: source.x + source.width / 2,
    y: source.y + source.height / 2,
  };
  const nodeCenter = {
    x: node.x + node.width / 2,
    y: node.y + node.height / 2,
  };
  const outward = {
    x: nodeCenter.x - sourceCenter.x,
    y: nodeCenter.y - sourceCenter.y,
  };

  return candidates
    .filter((candidate) => {
      const placed = { ...node, ...candidate };
      return obstacles.every(
        (obstacle) => !rectanglesOverlap(placed, obstacle, gap),
      );
    })
    .sort((left, right) => {
      const leftDelta = { x: left.x - node.x, y: left.y - node.y };
      const rightDelta = { x: right.x - node.x, y: right.y - node.y };
      const distanceDifference =
        leftDelta.x ** 2 +
        leftDelta.y ** 2 -
        (rightDelta.x ** 2 + rightDelta.y ** 2);
      if (distanceDifference !== 0) {
        return distanceDifference;
      }
      const leftOutward = leftDelta.x * outward.x + leftDelta.y * outward.y;
      const rightOutward = rightDelta.x * outward.x + rightDelta.y * outward.y;
      if (leftOutward !== rightOutward) {
        return rightOutward - leftOutward;
      }
      return left.x - right.x || left.y - right.y;
    })[0];
}

export function avoidCanvasNodeOverlaps(
  nodes: readonly CanvasRectangle[],
  anchorNodeIds: ReadonlySet<string>,
  gap = defaultCanvasNodeGap,
): CanvasRectangle[] {
  if (nodes.length < 2 || anchorNodeIds.size === 0) {
    return nodes.map((node) => ({ ...node }));
  }
  const currentById = new Map(nodes.map((node) => [node.id, { ...node }]));
  const placed: CanvasRectangle[] = nodes
    .filter((node) => anchorNodeIds.has(node.id))
    .map((node) => currentById.get(node.id)!);
  const placedIds = new Set(placed.map((node) => node.id));
  const queue = [...placed];

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const source = queue[queueIndex];
    for (const original of nodes) {
      if (placedIds.has(original.id)) {
        continue;
      }
      const current = currentById.get(original.id)!;
      if (!rectanglesOverlap(source, current, gap)) {
        continue;
      }
      const position = nearestAvailablePosition(current, placed, source, gap);
      current.x = position.x;
      current.y = position.y;
      placed.push(current);
      placedIds.add(current.id);
      queue.push(current);
    }
  }

  return nodes.map((node) => currentById.get(node.id)!);
}

export function removeAllCanvasNodeOverlaps(
  nodes: readonly CanvasRectangle[],
  gap = defaultCanvasNodeGap,
): CanvasRectangle[] {
  const ordered = nodes
    .map((node) => ({ ...node }))
    .sort(
      (left, right) =>
        left.y - right.y ||
        left.x - right.x ||
        left.id.localeCompare(right.id),
    );
  const placed: CanvasRectangle[] = [];
  for (const node of ordered) {
    if (placed.some((obstacle) => rectanglesOverlap(node, obstacle, gap))) {
      const position = nearestAvailablePosition(
        node,
        placed,
        placed[placed.length - 1],
        gap,
      );
      node.x = position.x;
      node.y = position.y;
    }
    placed.push(node);
  }
  const byId = new Map(placed.map((node) => [node.id, node]));
  return nodes.map((node) => byId.get(node.id)!);
}

export function canvasRectanglesOverlap(
  left: CanvasRectangle,
  right: CanvasRectangle,
  gap = defaultCanvasNodeGap,
): boolean {
  return rectanglesOverlap(left, right, gap);
}
