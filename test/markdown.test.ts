import { describe, expect, it } from "vitest";

// @ts-expect-error - plain JS module shared with the dashboard build.
import { renderMarkdown, stripTitle } from "../web/src/lib/markdown.js";

/**
 * The release notes panel renders text fetched from the GitHub API, so this is remote
 * input. The escaping tests below are the point of the module: a Markdown library would
 * render embedded HTML by design, which is exactly what must not happen here.
 */
describe("the release notes renderer", () => {
    it("renders the shape release notes actually take", () => {
        const html = renderMarkdown(
            ["### Fixed", "- **Claim totals keep up.** They move as each claim lands."].join("\n"),
        );
        expect(html).toBe(
            "<h5>Fixed</h5><ul><li><strong>Claim totals keep up.</strong> " +
                "They move as each claim lands.</li></ul>",
        );
    });

    it("joins a bullet that wraps over several lines", () => {
        // The notes wrap long bullets rather than letting them run off, so an indented
        // continuation belongs to the bullet above it and not to a list item of its own.
        const html = renderMarkdown(
            ["- **Campaign completions show the game.** The notification", "  carries the box art."].join("\n"),
        );
        expect(html).toBe(
            "<ul><li><strong>Campaign completions show the game.</strong> " +
                "The notification carries the box art.</li></ul>",
        );
    });

    it("keeps separate bullets separate", () => {
        const html = renderMarkdown(["- one", "- two"].join("\n"));
        expect(html).toBe("<ul><li>one</li><li>two</li></ul>");
    });

    it("starts a new block after a blank line", () => {
        const html = renderMarkdown(["- a bullet", "", "A paragraph."].join("\n"));
        expect(html).toBe("<ul><li>a bullet</li></ul><p>A paragraph.</p>");
    });

    it("escapes HTML rather than rendering it", () => {
        const html = renderMarkdown("<img src=x onerror=alert(1)>");
        expect(html).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
        expect(html).not.toContain("<img");
    });

    it("escapes HTML inside a bullet and inside emphasis", () => {
        expect(renderMarkdown("- **<script>bad()</script>**")).toBe(
            "<ul><li><strong>&lt;script&gt;bad()&lt;/script&gt;</strong></li></ul>",
        );
    });

    it("refuses a link that does not go to a web page", () => {
        // eslint-disable-next-line no-script-url
        const html = renderMarkdown("[click](javascript:alert(1))");
        expect(html).not.toContain("<a");
        expect(html).toContain("[click]");
    });

    it("renders an ordinary link, opening it away from the app", () => {
        const html = renderMarkdown("[notes](https://example.com/x)");
        expect(html).toContain('<a href="https://example.com/x" target="_blank" rel="noreferrer noopener">notes</a>');
    });

    it("leaves emphasis markers inside code alone", () => {
        expect(renderMarkdown("Use `a ** b` here")).toBe("<p>Use <code>a ** b</code> here</p>");
    });

    it("does not italicise a stray asterisk mid-word", () => {
        expect(renderMarkdown("2 * 3 * 4")).toBe("<p>2 * 3 * 4</p>");
    });

    it("shifts headings below the panel's own", () => {
        expect(renderMarkdown("# Title")).toBe("<h3>Title</h3>");
        expect(renderMarkdown("### Section")).toBe("<h5>Section</h5>");
    });

    it("survives empty and missing notes", () => {
        expect(renderMarkdown("")).toBe("");
        expect(renderMarkdown(null)).toBe("");
        expect(renderMarkdown(undefined)).toBe("");
    });
});

describe("stripping the title a tag message opens with", () => {
    it("drops a leading title that repeats the version", () => {
        expect(stripTitle("Sluice 0.4.2\n\nBody text.", "v0.4.2")).toBe("Body text.");
    });

    it("leaves notes that do not begin with the version", () => {
        expect(stripTitle("First working release.\n\nMore.", "v0.4.1")).toBe("First working release.\n\nMore.");
    });

    it("does not strip a title belonging to another version", () => {
        expect(stripTitle("Sluice 0.4.1\n\nBody.", "v0.4.2")).toBe("Sluice 0.4.1\n\nBody.");
    });
});
