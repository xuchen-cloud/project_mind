// @vitest-environment node
import {expect, it, vi} from 'vitest';
import {JSDOM} from 'jsdom';

it('does not retain a new set of window interaction listeners for every parsed rich-text document', () => {
  const {window} = new JSDOM('<input id="first"><input id="second">');
  const listen = vi.spyOn(window, 'addEventListener');
  try {
    for (let index = 0; index < 50; index++) {
      const parsed = new window.DOMParser().parseFromString(`<p class="body">${index}</p>`, 'text/html');
      expect(parsed.querySelector('.body')?.textContent).toBe(String(index));
    }
    const interactionTypes = new Set(['focus', 'focusin', 'keydown', 'keyup', 'mouseover', 'mousedown', 'mouseup', 'click', 'mouseout']);
    expect(listen.mock.calls.filter(([type]) => interactionTypes.has(type)).length).toBeLessThanOrEqual(9);
    const first = window.document.querySelector<HTMLInputElement>('#first')!;
    const second = window.document.querySelector<HTMLInputElement>('#second')!;
    first.focus();
    expect(window.document.querySelector(':focus')).toBe(first);
    second.focus();
    expect(window.document.querySelector(':focus')).toBe(second);
  } finally {
    listen.mockRestore();
    window.close();
  }
});
