import type { ReactElement } from "react";
import { useStore } from "../state/store.tsx";
import { Icon } from "./Icon.tsx";
import styles from "./Toasts.module.css";

/** 非阻塞通知（扩展 notify、错误提示、连接状态）。 */
export function Toasts(): ReactElement {
	const { state, actions } = useStore();
	return (
		<div className={styles.stack} role="status" aria-live="polite">
			{state.toasts.map((toast) => (
				<div key={toast.id} className={styles.toast} data-kind={toast.kind}>
					<span className={styles.text}>{toast.text}</span>
					<button className={styles.close} aria-label="关闭通知" onClick={() => actions.dismissToast(toast.id)}>
						<Icon name="x" />
					</button>
				</div>
			))}
		</div>
	);
}
