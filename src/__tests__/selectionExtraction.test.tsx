import { getSelectedTranscriptText, SELECTION_IGNORE_ATTR } from "@/app/dictation/[videoId]/helpers";

/**
 * Regression coverage for the "ⓘ info-button text leaking into saved
 * vocabulary" bug: ScriptTab renders a real, visible "ⓘ" button right next
 * to each highlighted phrase on phone (only hidden via CSS on desktop), so a
 * plain `Selection.toString()` picks up its glyph whenever a drag/long-press
 * selection spans across it. getSelectedTranscriptText fixes this by
 * excluding any DOM subtree marked with SELECTION_IGNORE_ATTR while walking
 * the actual Range — these tests build the same DOM shape ScriptTab
 * produces and assert on the extracted text directly, rather than asserting
 * on markup/class names.
 */

/** A span whose only child is a text node — mirrors the leaf spans ScriptTab
 *  renders for each word/phrase/punct/space render item. */
function textSpan(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.textContent = text;
  return span;
}

/** Mirrors ScriptTab's phrase wrapper: a highlighted phrase span followed by
 *  a sibling decorative "ⓘ" button, both inside one non-wrapping wrapper —
 *  exactly the shape that let the icon's glyph leak into a drag selection. */
function phraseWithIcon(phraseText: string): HTMLSpanElement {
  const wrapper = document.createElement("span");
  wrapper.appendChild(textSpan(phraseText));
  const icon = document.createElement("button");
  icon.setAttribute(SELECTION_IGNORE_ATTR, "true");
  icon.textContent = "ⓘ";
  wrapper.appendChild(icon);
  return wrapper;
}

function rangeOverAllChildren(root: HTMLElement): Range {
  const range = document.createRange();
  range.selectNodeContents(root);
  return range;
}

describe("getSelectedTranscriptText", () => {
  it("excludes a single decorative info-icon from a selection dragged across it", () => {
    const container = document.createElement("p");
    container.appendChild(phraseWithIcon("walkable"));
    container.appendChild(textSpan(" "));
    container.appendChild(textSpan("neighborhoods"));
    document.body.appendChild(container);

    const text = getSelectedTranscriptText(rangeOverAllChildren(container));
    expect(text).toBe("walkable neighborhoods");
    expect(text).not.toContain("ⓘ");

    document.body.removeChild(container);
  });

  it("excludes several decorative info-icons from one selection spanning multiple highlighted wrappers", () => {
    // Mirrors the reported "peopleⓘ of varyingⓘ ages" contamination: two
    // separate highlighted-phrase wrappers, each with its own icon, inside
    // one dragged selection.
    const container = document.createElement("p");
    container.appendChild(phraseWithIcon("people"));
    container.appendChild(textSpan(" of "));
    container.appendChild(phraseWithIcon("varying"));
    container.appendChild(textSpan(" ages"));
    document.body.appendChild(container);

    const text = getSelectedTranscriptText(rangeOverAllChildren(container));
    expect(text).toBe("people of varying ages");
    expect(text).not.toContain("ⓘ");

    document.body.removeChild(container);
  });

  it("preserves a partial selection into a highlighted phrase without pulling in the trailing icon", () => {
    const container = document.createElement("p");
    const wrapper = phraseWithIcon("reconcile");
    container.appendChild(wrapper);
    container.appendChild(textSpan(" differences"));
    document.body.appendChild(container);

    // Select only "concile" (mid-word) from the phrase span's text node —
    // simulates a drag that starts partway through the highlighted phrase.
    const phraseTextNode = wrapper.firstChild!.firstChild!; // wrapper > phraseSpan > text
    const range = document.createRange();
    range.setStart(phraseTextNode, 2);
    range.setEnd(container, container.childNodes.length);

    const text = getSelectedTranscriptText(range);
    expect(text).toBe("concile differences");
    expect(text).not.toContain("ⓘ");

    document.body.removeChild(container);
  });

  it("leaves legitimate parenthetical text like '(i)' in real transcript content completely untouched", () => {
    const container = document.createElement("p");
    container.appendChild(textSpan("See point (i) below for details."));
    document.body.appendChild(container);

    const text = getSelectedTranscriptText(rangeOverAllChildren(container));
    expect(text).toBe("See point (i) below for details.");

    document.body.removeChild(container);
  });

  it("reconstructs plain text unaffected when there is no decorative element at all", () => {
    const container = document.createElement("p");
    container.appendChild(textSpan("go a long way toward"));
    document.body.appendChild(container);

    expect(getSelectedTranscriptText(rangeOverAllChildren(container))).toBe("go a long way toward");

    document.body.removeChild(container);
  });
});
