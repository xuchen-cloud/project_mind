export function getRovingTabTargetIndex({
  key,
  currentIndex,
  itemCount,
  vertical = false,
}: {
  key: string;
  currentIndex: number;
  itemCount: number;
  vertical?: boolean;
}) {
  if (itemCount <= 0 || currentIndex < 0 || currentIndex >= itemCount) {
    return null;
  }

  if (key === "ArrowRight" || (vertical && key === "ArrowDown")) {
    return (currentIndex + 1) % itemCount;
  }
  if (key === "ArrowLeft" || (vertical && key === "ArrowUp")) {
    return (currentIndex - 1 + itemCount) % itemCount;
  }
  if (key === "Home") return 0;
  if (key === "End") return itemCount - 1;
  return null;
}
