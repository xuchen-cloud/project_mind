import { afterEach, expect, it } from "vitest";
import todoStyles from "./todo.css?raw";
import tagStyles from "../tags/entity-tags.css?raw";
import homeStyles from "../home/home.css?raw";

// Exercise the actual cascade in both load orders: page CSS must not change
// the shared rail's text metrics or shift child text when editing starts.
afterEach(() => { document.head.querySelectorAll("[data-todo-style-test]").forEach((node) => node.remove()); document.body.replaceChildren(); });

for (const homeLast of [true, false]) {
  it(`keeps read/edit typography and subtask alignment stable with home CSS ${homeLast ? "last" : "first"}`, () => {
    const style = document.createElement("style");
    style.dataset.todoStyleTest = "true";
    style.textContent = homeLast ? tagStyles + todoStyles + homeStyles : homeStyles + todoStyles + tagStyles;
    document.head.append(style);
    for (const wrapper of ["home-rail home-rail--workspace", "home-rail home-rail--project", "note-page"]) {
      document.body.innerHTML = `<div class="${wrapper}"><aside class="todo-rail"><article class="todo-card">
        <div class="todo-inline-content text-body font-medium leading-6">正文</div>
        <div class="todo-inline-editor"><span>正文占位</span><div role="textbox">正文</div></div>
        <div class="todo-card__tag-row"><span class="entity-tag-chip">标签</span></div>
        <div class="todo-progress-item"><p class="todo-progress-item__text">子任务</p></div>
      </article></aside></div>`;
      const read = getComputedStyle(document.querySelector(".todo-inline-content")!);
      const edit = getComputedStyle(document.querySelector('[role="textbox"]')!);
      expect([read.fontSize, read.fontWeight, read.lineHeight]).toEqual(["13px", "400", "20px"]);
      expect([edit.fontSize, edit.fontWeight, edit.lineHeight]).toEqual([read.fontSize, read.fontWeight, read.lineHeight]);
      expect(getComputedStyle(document.querySelector(".todo-inline-editor > span")!).fontSize).toBe(read.fontSize);
      expect(getComputedStyle(document.querySelector(".entity-tag-chip")!).fontSize).toBe("10px");
      const child = document.querySelector(".todo-progress-item__text")!;
      expect(getComputedStyle(child).fontSize).toBe("12px");
      const inset = getComputedStyle(child).paddingLeft;
      document.querySelector(".todo-card")!.setAttribute("data-state", "progress-editing");
      expect(getComputedStyle(child).paddingLeft).toBe(inset);
    }
  });
}
