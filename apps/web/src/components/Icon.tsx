import type { ReactElement } from "react";

/** SVG 图标 sprite（沿用 prototype 的图标集）。 */
export function IconSprite(): ReactElement {
	return (
		<svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
			<defs>
				<symbol id="i-pie" viewBox="0 0 24 24">
					<path fill="currentColor" d="M12 2a10 10 0 1 0 10 10h-9a1 1 0 0 1-1-1V2zm2 0a10 10 0 0 1 8 8h-8V2z" />
				</symbol>
				<symbol id="i-plus" viewBox="0 0 24 24">
					<path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M12 5v14M5 12h14" />
				</symbol>
				<symbol id="i-menu" viewBox="0 0 24 24">
					<path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
				</symbol>
				<symbol id="i-panel" viewBox="0 0 24 24">
					<rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
					<path stroke="currentColor" strokeWidth="2" d="M15 4v16" />
				</symbol>
				<symbol id="i-sun" viewBox="0 0 24 24">
					<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
					<path
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
					/>
				</symbol>
				<symbol id="i-moon" viewBox="0 0 24 24">
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinejoin="round"
						d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"
					/>
				</symbol>
				<symbol id="i-monitor" viewBox="0 0 24 24">
					<rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
					<path stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M8 20h8m-4-4v4" />
				</symbol>
				<symbol id="i-send" viewBox="0 0 24 24">
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M12 19V5m-6 6 6-6 6 6"
					/>
				</symbol>
				<symbol id="i-stop" viewBox="0 0 24 24">
					<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
				</symbol>
				<symbol id="i-chev" viewBox="0 0 24 24">
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						d="m9 6 6 6-6 6"
					/>
				</symbol>
				<symbol id="i-tool" viewBox="0 0 24 24">
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L14 13l-3-3 3.7-3.7z"
					/>
				</symbol>
				<symbol id="i-brain" viewBox="0 0 24 24">
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						d="M9.5 3A3 3 0 0 0 6.5 6c-1.9.5-3 2-3 3.8 0 1.2.5 2.2 1.3 2.9A3.5 3.5 0 0 0 7 19.5c.6 1 1.7 1.5 2.9 1.3M14.5 3A3 3 0 0 1 17.5 6c1.9.5 3 2 3 3.8 0 1.2-.5 2.2-1.3 2.9a3.5 3.5 0 0 1-2.2 6.8c-.6 1-1.7 1.5-2.9 1.3M12 3v18"
					/>
				</symbol>
				<symbol id="i-check" viewBox="0 0 24 24">
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						d="m4 12.5 5 5L20 6.5"
					/>
				</symbol>
				<symbol id="i-circle" viewBox="0 0 24 24">
					<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
				</symbol>
				<symbol id="i-spin" viewBox="0 0 24 24">
					<path fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" d="M12 3a9 9 0 1 1-9 9" />
				</symbol>
				<symbol id="i-x" viewBox="0 0 24 24">
					<path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="M6 6l12 12M18 6 6 18" />
				</symbol>
				<symbol id="i-agent" viewBox="0 0 24 24">
					<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="2" />
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"
					/>
				</symbol>
				<symbol id="i-job" viewBox="0 0 24 24">
					<rect x="3" y="7" width="18" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
					/>
				</symbol>
				<symbol id="i-task" viewBox="0 0 24 24">
					<rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						d="m8.5 12.5 2.5 2.5 4.5-5"
					/>
				</symbol>
				<symbol id="i-folder" viewBox="0 0 24 24">
					<path
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinejoin="round"
						d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"
					/>
				</symbol>
				<symbol id="i-search" viewBox="0 0 24 24">
					<circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
					<path stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="m16 16 4 4" />
				</symbol>
			</defs>
		</svg>
	);
}

export function Icon(props: { name: string; className?: string }): ReactElement {
	return (
		<svg className={props.className ? `icon ${props.className}` : "icon"} aria-hidden="true">
			<use href={`#i-${props.name}`} />
		</svg>
	);
}
