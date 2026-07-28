import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { UiGallery } from "../ui/gallery.ts";

export default function uiGalleryExtension(pi: ExtensionAPI) {
	pi.registerCommand("ui-gallery", {
		description: "Open the interactive Pi++ component gallery",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The UI gallery requires interactive TUI mode", "warning");
				return;
			}
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				let timer: ReturnType<typeof setInterval> | undefined;
				const close = () => {
					if (timer) clearInterval(timer);
					done();
				};
				const gallery = new UiGallery(theme, close);
				gallery.setMaxHeight(tui.terminal.rows - 3);
				timer = setInterval(() => {
					gallery.tick();
					tui.requestRender();
				}, 140);
				return {
					render: (width) => {
						gallery.setMaxHeight(tui.terminal.rows - 3);
						return gallery.render(width);
					},
					invalidate: () => gallery.invalidate(),
					handleInput: (data) => {
						gallery.handleInput(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}
