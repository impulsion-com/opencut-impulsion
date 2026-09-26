// Renders Claude's markdown replies in the chat panel (src/claude/chat), its only consumer. The text can echo
// untrusted input (file names, text read from frames), so nothing here may load a remote resource on its own:
// images render as their alt text, and links show where they go before anyone clicks.
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import { cn } from "@/utils/ui";

/** Drops every image URL (a markdown image would be fetched with no click) and sanitises the others. */
// eslint-disable-next-line opencut/prefer-object-params -- react-markdown's UrlTransform signature is positional
function safeUrlTransform(
	value: string,
	key: string,
	node: { tagName: string },
): string {
	if (node.tagName === "img" || key === "src") return "";
	return defaultUrlTransform(value);
}

function linkHost(href: string | undefined): string | null {
	if (!href) return null;
	try {
		const url = new URL(href);
		return url.protocol === "mailto:" ? null : url.host || null;
	} catch {
		return null;
	}
}

export function ReactMarkdownWrapper({
	children,
	inline = false,
}: {
	children: string;
	inline?: boolean;
}) {
	return (
		<ReactMarkdown
			urlTransform={safeUrlTransform}
			components={{
				a: ({ className: linkClassName, children, href, node: _node, ...props }) => {
					const host = linkHost(href);
					return (
						<a
							className={cn("text-primary hover:underline", linkClassName)}
							target="_blank"
							rel="noopener noreferrer"
							href={href}
							title={href}
							{...props}
						>
							{children}
							{host && children !== href && (
								<span className="text-muted-foreground"> ({host})</span>
							)}
						</a>
					);
				},
				img: ({ alt }) => (alt ? <span>{alt}</span> : null),
				strong: ({ children }) => (
					<strong className="text-foreground font-semibold">{children}</strong>
				),
				code: ({ className: codeClassName, children, node: _node, ...props }) => (
					<code
						className={cn(
							"rounded border border-destructive/20 bg-destructive/5 px-1.5 py-0.5 font-mono text-[0.85em] text-red-700 dark:text-red-300",
							codeClassName,
						)}
						{...props}
					>
						{children}
					</code>
				),
				p: ({ className: paragraphClassName, children, node: _node, ...props }) =>
					inline ? (
						<span className={cn("m-0", paragraphClassName)} {...props}>
							{children}
						</span>
					) : (
						<p className={cn("m-0", paragraphClassName)} {...props}>
							{children}
						</p>
					),
			}}
		>
			{children}
		</ReactMarkdown>
	);
}
