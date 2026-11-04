/** Deployment facts the pie host resolves before sources and workers run. */
export interface GithubAccount {
	cli: string;
	login: string;
	noreply: string;
}

export interface FeishuBot {
	cli: string;
	appId: string;
	brand: "feishu" | "lark";
	botId: string;
	name: string;
}

export interface Deployment {
	stateDir: string;
	repository: string;
	github: GithubAccount;
	feishu?: FeishuBot;
}
