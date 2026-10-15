import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { InternalReferencePicker } from "./InternalReferencePicker";

it("shows Workspace Record candidates with reversible scroll edges and clears them after filtering", () => {
  const props = {open:true,loading:false,activeIndex:0,onSelect:vi.fn(),results:[{kind:"workspace_record" as const,id:42,scope:"workspace" as const,projectId:null,label:"个人方法",subtitle:"工作区",updatedAt:"2026-10-01"}]};
  const view=render(<InternalReferencePicker {...props} />);
  expect(screen.getByRole("option")).toHaveAccessibleName("记录 个人方法 工作区");
  const viewport=screen.getByRole("region",{name:"内部引用候选"});
  Object.defineProperties(viewport,{clientHeight:{configurable:true,value:100},scrollHeight:{configurable:true,value:300}});
  fireEvent.scroll(viewport,{target:{scrollTop:168}});
  const frame=viewport.parentElement!;
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0.5");
  fireEvent.scroll(viewport,{target:{scrollTop:200}});
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0");
  fireEvent.scroll(viewport,{target:{scrollTop:168}});
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0.5");
  Object.defineProperty(viewport,"scrollHeight",{configurable:true,value:100});
  viewport.scrollTop=0;
  view.rerender(<InternalReferencePicker {...props} results={[]} />);
  expect(frame.style.getPropertyValue("--scroll-fade-bottom-opacity")).toBe("0");
  expect(frame.style.getPropertyValue("--scroll-fade-top-opacity")).toBe("0");
});
