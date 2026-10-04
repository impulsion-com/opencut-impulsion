import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	compiler: {
		removeConsole: process.env.NODE_ENV === "production",
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	// Monorepo root; also silences the multiple-lockfile warning caused by
	// a package-lock.json higher up in the home directory.
	turbopack: {
		root: path.join(__dirname, "../.."),
	},
	// Workspace package shipped as TypeScript source.
	transpilePackages: ["@opencut/claude-tools", "@opencut/motion-blocks"],
	// No site may frame the editor: a framed tab would connect to the Claude bridge with our own Origin.
	async headers() {
		return [
			{
				source: "/:path*",
				headers: [
					{ key: "X-Frame-Options", value: "DENY" },
					{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
				],
			},
		];
	},
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "api.iconify.design",
			},
			{
				protocol: "https",
				hostname: "api.simplesvg.com",
			},
			{
				protocol: "https",
				hostname: "api.unisvg.com",
			},
			{
				protocol: "https",
				hostname: "cdn.brandfetch.io",
			},
		],
	},
};

export default nextConfig;
