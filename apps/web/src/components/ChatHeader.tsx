import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { useStore, type ViewTab } from "../state/store.tsx";
import { Icon } from "./Icon.tsx";
import styles from "./ChatHeader.module.css";

function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const media = window.matchMedia(query);
		const onChange = () => setMatches(media.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

const VIEW_TABS: Array<{ key: ViewTab; label: string }> = [
	{ key: "chat", label: "对话" },
	{ key: "trajectory", label: "轨迹" },
];

export function ChatHeader(props: { title: string }): ReactElement {
	const { state, actions } = useStore();
	const isRightDrawer = useMediaQuery("(max-width: 1279px)");
	const rightOpen = isRightDrawer ? state.rightDrawerOpen : !state.rightCollapsed;

	return (
		<header className="chat-head">
			<button
				className="icon-btn mobile-only"
				aria-label="打开会话列表"
				aria-expanded={state.sidebarOpen}
				onClick={() => actions.setSidebarOpen(true)}
			>
				<Icon name="menu" />
			</button>
			<h1>{props.title}</h1>
			<div className={styles.viewTabs} role="tablist" aria-label="中央视图">
				{VIEW_TABS.map((tab) => (
					<button
						key={tab.key}
						className={styles.viewTab}
						role="tab"
						aria-selected={state.view === tab.key}
						onClick={() => actions.setView(tab.key)}
					>
						{tab.label}
					</button>
				))}
			</div>
			<button
				className="icon-btn"
				aria-label={rightOpen ? "关闭任务面板" : "打开任务面板"}
				aria-expanded={rightOpen}
				onClick={() => {
					if (isRightDrawer) actions.setRightDrawerOpen(!state.rightDrawerOpen);
					else actions.toggleRight();
				}}
			>
				<Icon name="panel" />
			</button>
		</header>
	);
}
