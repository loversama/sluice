/**
 * A very small Markdown renderer, for the release notes shown in settings.
 *
 * The notes are fetched from GitHub at run time, so they are remote text. Everything is
 * escaped before any markup is added and only a fixed set of tags is ever produced, which
 * is the reason this exists rather than a Markdown library: the ones worth using render
 * embedded HTML by design, and would need a sanitiser behind them to be safe on input that
 * arrives over the network.
 *
 * It covers what release notes actually use - headings, bullets, paragraphs, bold, italic,
 * code, links and rules. Anything else is left as text rather than guessed at.
 */

const ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (character) => ESCAPE[character]);
}

/** Only somewhere a browser should be willing to go: no javascript:, no data:. */
function safeHref(url) {
    return /^https?:\/\/[^\s<>"']+$/i.test(url) ? url : null;
}

/**
 * Stands in for a code span while the emphasis rules run, so that `**` inside code stays
 * literal. A null character cannot survive escaping, so it can never arrive in the input.
 */
const HOLD = "\u0000";

function inline(text) {
    const code = [];
    let out = escapeHtml(text).replace(/`([^`]+)`/g, (_, body) => {
        code.push(body);
        return `${HOLD}${code.length - 1}${HOLD}`;
    });

    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
        const href = safeHref(url);
        // An unsafe or malformed link stays as the literal text it was written as.
        return href ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>` : whole;
    });

    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // The delimiters have to hug their text, the way Markdown requires, or arithmetic like
    // "2 * 3 * 4" turns into emphasis.
    out = out.replace(/(^|[\s(])[*_](\S(?:[^*_\n]*\S)?)[*_](?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");

    return out.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, "g"), (_, index) => `<code>${code[Number(index)]}</code>`);
}

/** Release notes as HTML, safe to hand to v-html. */
export function renderMarkdown(source) {
    const lines = String(source ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n");

    const html = [];
    let paragraph = [];
    let items = null;

    const flushParagraph = () => {
        if (paragraph.length) {
            html.push(`<p>${inline(paragraph.join(" "))}</p>`);
            paragraph = [];
        }
    };
    const flushList = () => {
        if (items) {
            html.push(`<ul>${items.map((item) => `<li>${inline(item.join(" "))}</li>`).join("")}</ul>`);
            items = null;
        }
    };
    const flush = () => {
        flushParagraph();
        flushList();
    };

    for (const raw of lines) {
        const line = raw.replace(/\s+$/, "");
        if (!line.trim()) {
            flush();
            continue;
        }

        if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) {
            flush();
            html.push("<hr>");
            continue;
        }

        const heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
        if (heading) {
            flush();
            // Shifted down two: the panel around this already owns the higher levels.
            const level = Math.min(6, heading[1].length + 2);
            html.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
            continue;
        }

        const bullet = /^\s{0,3}[-*+]\s+(.+)$/.exec(line);
        if (bullet) {
            flushParagraph();
            if (!items) items = [];
            items.push([bullet[1].trim()]);
            continue;
        }

        // A line under an open bullet continues it, which is how the notes wrap a long
        // bullet over several lines rather than letting it run off.
        if (items) {
            items[items.length - 1].push(line.trim());
            continue;
        }

        paragraph.push(line.trim());
    }

    flush();
    return html.join("");
}

/**
 * The notes without the title line the tag message opens with.
 *
 * `git tag -l --format='%(contents)'` hands over subject and body together, so a release
 * body begins "Sluice 0.4.2" - which the panel has already put in the heading beside the
 * date. Repeating it is noise.
 */
export function stripTitle(notes, version) {
    const text = String(notes ?? "").replace(/\r\n?/g, "\n");
    const tag = String(version ?? "").replace(/^v/, "");
    const first = text.split("\n", 1)[0].trim();
    const looksLikeTitle = first === `Sluice ${tag}` || first === tag || first === `v${tag}`;
    return looksLikeTitle ? text.slice(text.indexOf("\n") + 1).replace(/^\n+/, "") : text;
}
