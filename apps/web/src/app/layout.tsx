import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "../components/ui/sonner";
import { TooltipProvider } from "../components/ui/tooltip";
import { baseMetaData } from "./metadata";
import localFont from "next/font/local";

// Inter (SIL Open Font License 1.1, https://github.com/rsms/inter), latin
// subset, vendored so the shell compiles and renders with no network access.
const siteFont = localFont({
	src: "../fonts/inter/inter-latin-variable.woff2",
	weight: "100 900",
	style: "normal",
	display: "swap",
});

export const metadata = baseMetaData;

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body className={`${siteFont.className} font-sans antialiased`}>
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					disableTransitionOnChange={true}
				>
					<TooltipProvider>
						<Toaster />
						{children}
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	);
}
