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
	transpilePackages: ["@opencut/claude-tools"],
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
