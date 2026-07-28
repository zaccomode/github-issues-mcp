/**
 * Projections that trim GitHub's REST payloads down to the fields a model
 * actually needs. A raw issue object carries ~100 keys, the vast majority of
 * which are API URLs and permission flags — returning them verbatim burns a
 * large amount of context on every listing for no benefit.
 */

/** A label is either a full object or, on some endpoints, a bare string. */
function labelName(label: any): string {
	return typeof label === "string" ? label : label.name;
}

export function compactIssue(issue: any) {
	return {
		number: issue.number,
		title: issue.title,
		state: issue.state,
		state_reason: issue.state_reason ?? undefined,
		labels: (issue.labels ?? []).map(labelName),
		assignees: (issue.assignees ?? []).map((a: any) => a.login),
		milestone: issue.milestone?.title ?? undefined,
		type: issue.type?.name ?? undefined,
		author: issue.user?.login,
		comments: issue.comments,
		created_at: issue.created_at,
		updated_at: issue.updated_at,
		closed_at: issue.closed_at ?? undefined,
		url: issue.html_url,
		body: issue.body ?? undefined,
		// Only present when the "issue" is really a pull request. Callers that
		// opt into PRs need to be able to tell them apart.
		is_pull_request: issue.pull_request ? true : undefined,
	};
}

/**
 * Pull requests carry everything an issue does plus the branch pair and merge
 * state. `closes_issues` is not part of the REST payload — GitHub exposes the
 * issue link only through GraphQL — so the tool layer folds it in separately.
 */
export function compactPullRequest(pr: any) {
	return {
		number: pr.number,
		title: pr.title,
		state: pr.state,
		draft: pr.draft ?? undefined,
		merged: pr.merged ?? undefined,
		// Absent from list payloads; only the single-PR endpoint computes it.
		mergeable_state: pr.mergeable_state ?? undefined,
		head: pr.head?.label ?? pr.head?.ref,
		base: pr.base?.ref,
		labels: (pr.labels ?? []).map(labelName),
		assignees: (pr.assignees ?? []).map((a: any) => a.login),
		requested_reviewers: (pr.requested_reviewers ?? []).map((r: any) => r.login),
		milestone: pr.milestone?.title ?? undefined,
		author: pr.user?.login,
		comments: pr.comments,
		created_at: pr.created_at,
		updated_at: pr.updated_at,
		closed_at: pr.closed_at ?? undefined,
		merged_at: pr.merged_at ?? undefined,
		url: pr.html_url,
		body: pr.body ?? undefined,
	};
}

export function compactComment(comment: any) {
	return {
		id: comment.id,
		author: comment.user?.login,
		created_at: comment.created_at,
		updated_at: comment.updated_at,
		url: comment.html_url,
		body: comment.body,
	};
}

export function compactLabel(label: any) {
	return {
		name: label.name,
		color: label.color,
		description: label.description ?? undefined,
	};
}
