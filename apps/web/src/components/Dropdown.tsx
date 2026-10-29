import { useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Icon } from "./Icon.tsx";
import styles from "./Dropdown.module.css";

export interface DropdownItem {
	key: string;
	label: string;
	meta?: string;
	group?: string;
	current?: boolean;
	onSelect: () => void;
}

/** 轻量下拉（向上弹出），用于 composer 的模型/思考强度选择。 */
export function Dropdown(props: {
	label: ReactNode;
	ariaLabel: string;
	items: DropdownItem[];
	disabled?: boolean;
}): ReactElement {
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	let lastGroup: string | undefined;

	return (
		<div className={styles.wrap} ref={wrapRef}>
			<button
				className="select-chip"
				aria-label={props.ariaLabel}
				aria-expanded={open}
				disabled={props.disabled}
				onClick={() => setOpen(!open)}
			>
				{props.label}
				<Icon name="chev" />
			</button>
			{open && (
				<div className={styles.menu} role="menu">
					{props.items.length === 0 && <div className={styles.group}>无可选项</div>}
					{props.items.map((item) => {
						const groupHeader =
							item.group !== undefined && item.group !== lastGroup ? (
								<div className={styles.group} key={`g-${item.group}`}>
									{item.group}
								</div>
							) : null;
						lastGroup = item.group;
						return (
							<div key={item.key}>
								{groupHeader}
								<button
									className={styles.item}
									role="menuitemradio"
									aria-current={item.current === true}
									onClick={() => {
										setOpen(false);
										item.onSelect();
									}}
								>
									<Icon name="check" />
									<span className={styles.itemLabel}>{item.label}</span>
									{item.meta && <span className={styles.itemMeta}>{item.meta}</span>}
								</button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
