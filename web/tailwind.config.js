export default {
    content: ["./index.html", "./src/**/*.{vue,js,ts}"],
    darkMode: "class",
    theme: {
        extend: {
            colors: {
                bg: "var(--bg)",
                surface: "var(--surface)",
                "surface-2": "var(--surface-2)",
                border: "var(--border)",
                content: "var(--text)",
                "content-2": "var(--text-2)",
                accent: "var(--accent)",
                success: "var(--success)",
                info: "var(--info)",
                warn: "var(--warn)",
                danger: "var(--danger)",
                muted: "var(--muted)",
            },
            fontFamily: {
                mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
            },
        },
    },
};
