/** Setup problems shown by the panel until repository and account checks succeed. */
export type SetupPlace = "github" | "feishu" | "deployment";

export class SetupError extends Error {
	readonly problem: string;
	readonly values: Record<string, string>;
	constructor(problem: string, values: Record<string, string> = {}) {
		super(problem);
		this.problem = problem;
		this.values = values;
	}
}

export interface SetupProblem {
	problem: string;
	detail: string;
	place: SetupPlace;
}
