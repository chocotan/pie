import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useStore } from "../state/store.tsx";
import styles from "./ExtensionModal.module.css";

/** 扩展 UI 请求（select/confirm/input/editor）的模态回复框。 */
export function ExtensionModal(): ReactElement | null {
	const { state, actions } = useStore();
	const extUi = state.extUi;
	const [text, setText] = useState("");
	const dialogRef = useRef<HTMLDivElement>(null);

	// 每个新请求重置草稿，并把焦点移入对话框
	const requestId = extUi?.request.id;
	useEffect(() => {
		if (!extUi) return;
		const req = extUi.request;
		setText(req.method === "editor" ? (req.prefill ?? "") : "");
		dialogRef.current?.querySelector<HTMLElement>("button, input, textarea")?.focus();
	}, [requestId, extUi]);

	if (!extUi) return null;
	const request = extUi.request;
	// notify 走 toast，不弹模态；类型上仍可能出现在这里
	if (request.method === "notify") return null;

	function cancel(): void {
		void actions.respondExtensionUI({ id: request.id, cancelled: true });
	}

	function submitValue(value: string): void {
		void actions.respondExtensionUI({ id: request.id, value });
	}

	return (
		<div
			className={styles.overlay}
			onPointerDown={(e) => {
				if (e.target === e.currentTarget) cancel();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					cancel();
				}
			}}
		>
			<div className={styles.dialog} role="dialog" aria-modal="true" aria-label={request.title} ref={dialogRef}>
				<h2 className={styles.title}>
					<span className={`badge info ${styles.tag}`}>扩展提问</span>
					{request.title}
				</h2>

				{request.method === "confirm" && (
					<>
						<p className={styles.message}>{request.message}</p>
						<div className={styles.actions}>
							<button className={styles.btnGhost} onClick={() => void actions.respondExtensionUI({ id: request.id, confirmed: false })}>
								拒绝
							</button>
							<button className={styles.btnPrimary} onClick={() => void actions.respondExtensionUI({ id: request.id, confirmed: true })}>
								确认
							</button>
						</div>
					</>
				)}

				{request.method === "select" && (
					<>
						<div className={styles.options}>
							{request.options.map((option) => (
								<button key={option} className={styles.option} onClick={() => submitValue(option)}>
									{option}
								</button>
							))}
						</div>
						<div className={styles.actions}>
							<button className={styles.btnGhost} onClick={cancel}>
								取消
							</button>
						</div>
					</>
				)}

				{request.method === "input" && (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							submitValue(text);
						}}
					>
						<input
							className={styles.textInput}
							value={text}
							placeholder={request.placeholder}
							aria-label={request.title}
							onChange={(e) => setText(e.target.value)}
						/>
						<div className={styles.actions}>
							<button type="button" className={styles.btnGhost} onClick={cancel}>
								取消
							</button>
							<button type="submit" className={styles.btnPrimary}>
								提交
							</button>
						</div>
					</form>
				)}

				{request.method === "editor" && (
					<>
						<textarea
							className={styles.editorArea}
							value={text}
							aria-label={request.title}
							onChange={(e) => setText(e.target.value)}
						/>
						<div className={styles.actions}>
							<button className={styles.btnGhost} onClick={cancel}>
								取消
							</button>
							<button className={styles.btnPrimary} onClick={() => submitValue(text)}>
								提交
							</button>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
