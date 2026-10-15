import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { useHomeHeadingMotion } from "./useHomeHeadingMotion";

function Harness() {
  const section = useRef<HTMLElement>(null);
  useHomeHeadingMotion(section, "project:1", "项目");
  return <div className="home-window-shell" style={{ "--home-toolbar-height": "36px", "--home-sticky-gap": "12px" } as React.CSSProperties}>
    <div className="project-overview-focus__scroll" data-testid="scroll">
      <div className="home-cover"><div className="home-cover__identity" data-testid="source"><span className="home-cover__title">项目</span></div></div>
      <section ref={section} data-testid="section"><div className="home-quick-note__page-heading" data-testid="heading">项目</div></section>
    </div>
  </div>;
}
it("anchors the moving heading to the content viewport below the toolbar and follows reverse scroll", () => {
  render(<Harness />);
  const scroller = screen.getByTestId("scroll"), source = screen.getByTestId("source"), section = screen.getByTestId("section");
  scroller.getBoundingClientRect = () => ({ top: 36 } as DOMRect);
  section.getBoundingClientRect = () => ({ top: 100, left: 100 } as DOMRect);
  Object.defineProperty(section, "clientWidth", { value: 600 });
  source.getBoundingClientRect = () => ({ top: 10, left: 100, width: 300 } as DOMRect);
  fireEvent.scroll(scroller);
  expect(screen.getByTestId("heading").style.transform).toBe("translate(0px, -22px) scale(1)");
  expect(source.style.visibility).toBe("hidden");
  source.getBoundingClientRect = () => ({ top: 200, left: 100, width: 300 } as DOMRect);
  fireEvent.scroll(scroller);
  expect(source.style.visibility).toBe("");
});
