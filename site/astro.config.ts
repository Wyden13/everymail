import { designPlugin } from "@everymail/design/plugin";
import { defineConfig } from "astro/config";

export default defineConfig({
	server: { port: 4321 },
	devToolbar: { enabled: false },
	vite: {
		plugins: [designPlugin()],
		// The waitlist form posts to the Backend on the page's own origin, as it will in production.
		server: { proxy: { "/api.v1.": "http://127.0.0.1:8787" } },
	},
});
