import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { HomeSidebarList } from "./HomeSidebarList";

it("shows only the edges with hidden content and clears them when content fits", () => {
  const view = render(<HomeSidebarList label="项目列表"><button>项目</button></HomeSidebarList>);
  const list = screen.getByRole("region", { name: "项目列表" });
  Object.defineProperties(list, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 300 },
  });
  fireEvent.scroll(list, { target: { scrollTop: 0 } });
  expect(list).not.toHaveAttribute("data-overflow-top");
  expect(list).toHaveAttribute("data-overflow-bottom");
  fireEvent.scroll(list, { target: { scrollTop: 80 } });
  expect(list).toHaveAttribute("data-overflow-top");
  expect(list).toHaveAttribute("data-overflow-bottom");
  fireEvent.scroll(list, { target: { scrollTop: 200 } });
  expect(list).toHaveAttribute("data-overflow-top");
  expect(list).not.toHaveAttribute("data-overflow-bottom");
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: 100 });
  list.scrollTop = 0;
  view.rerender(<HomeSidebarList label="项目列表"><button>筛选后的项目</button></HomeSidebarList>);
  expect(list).not.toHaveAttribute("data-overflow-top");
  expect(list).not.toHaveAttribute("data-overflow-bottom");
});


it.each(["sidebar", "todo"] as const)("%s ties fade strength to scroll distance and reverses immediately when dragging back", (variant) => {
  render(<HomeSidebarList label="标签列表" variant={variant}><button>标签</button></HomeSidebarList>);
  const list = screen.getByRole("region", { name: "标签列表" });
  Object.defineProperties(list, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
  const frame = list.parentElement!;
  fireEvent.scroll(list, { target: { scrollTop: 168 } });
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0.5");
  fireEvent.scroll(list, { target: { scrollTop: 184 } });
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0.25");
  fireEvent.scroll(list, { target: { scrollTop: 200 } });
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0");
  fireEvent.scroll(list, { target: { scrollTop: 168 } });
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0.5");
  fireEvent.scroll(list, { target: { scrollTop: 32 } });
  expect(frame.style.getPropertyValue("--scroll-fade-top-opacity")).toBe("0.5");
});


it.each(["sidebar", "todo"] as const)("%s fully fades short overflow rather than leaving an opaque card edge", (variant) => {
  render(<HomeSidebarList label="短溢出列表" variant={variant}><div>卡片</div></HomeSidebarList>);
  const list = screen.getByRole("region", { name: "短溢出列表" });
  Object.defineProperties(list, { clientHeight: { value: 286 }, scrollHeight: { value: 310 } });
  const frame = list.parentElement!;
  fireEvent.scroll(list, { target: { scrollTop: 0 } });
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("1");
  fireEvent.scroll(list, { target: { scrollTop: 18 } });
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0.5");
  fireEvent.scroll(list, { target: { scrollTop: 24 } });
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0");
  expect(frame.style.getPropertyValue("--scroll-fade-top-opacity")).toBe("1");
});
