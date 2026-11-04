import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dropdown } from "../src/components/Dropdown.tsx";

describe("Dropdown", () => {
	it("marks only the current item selected", () => {
		const html = renderToStaticMarkup(
			createElement(Dropdown, {
				label: "模型",
				ariaLabel: "切换模型",
				defaultOpen: true,
				items: [
					{ key: "a", label: "A", current: true, onSelect: () => {} },
					{ key: "b", label: "B", onSelect: () => {} },
				],
			}),
		);
		expect(html.match(/aria-current="true"/g)).toHaveLength(1);
		expect(html).toContain("B");
	});
});
