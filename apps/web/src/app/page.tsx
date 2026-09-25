import { redirect } from "next/navigation";

// Local-only build: no landing page, the app opens on the project list.
export default function Home() {
	redirect("/projects");
}
