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

// ------------------------------------------------------------ security alerts
//
// Every projection below names its fields explicitly rather than spreading the
// payload and deleting a few. For secret scanning that is what keeps the leaked
// secret itself out of the result: an allowlist cannot pass through a field it
// does not name, including one GitHub adds later.

const login = (user: any): string | undefined => user?.login ?? undefined;

/** CVSS v4 where GitHub has it, then v3, then the deprecated single score. */
function cvssScore(advisory: any): number | undefined {
	const score =
		advisory?.cvss_severities?.cvss_v4?.score ??
		advisory?.cvss_severities?.cvss_v3?.score ??
		advisory?.cvss?.score;
	// GitHub reports 0 rather than null for an advisory that was never scored.
	return score || undefined;
}

export function compactDependabotAlert(alert: any, detail = false) {
	const advisory = alert.security_advisory ?? {};
	const vulnerability = alert.security_vulnerability ?? {};
	return {
		number: alert.number,
		state: alert.state,
		severity: vulnerability.severity ?? advisory.severity,
		package: alert.dependency?.package?.name,
		ecosystem: alert.dependency?.package?.ecosystem,
		manifest_path: alert.dependency?.manifest_path,
		scope: alert.dependency?.scope ?? undefined,
		vulnerable_version_range: vulnerability.vulnerable_version_range ?? undefined,
		first_patched_version: vulnerability.first_patched_version?.identifier ?? undefined,
		ghsa_id: advisory.ghsa_id,
		cve_id: advisory.cve_id ?? undefined,
		summary: advisory.summary,
		created_at: alert.created_at,
		updated_at: alert.updated_at,
		fixed_at: alert.fixed_at ?? undefined,
		dismissed_at: alert.dismissed_at ?? undefined,
		dismissed_by: login(alert.dismissed_by),
		dismissed_reason: alert.dismissed_reason ?? undefined,
		dismissed_comment: alert.dismissed_comment ?? undefined,
		auto_dismissed_at: alert.auto_dismissed_at ?? undefined,
		url: alert.html_url,
		...(detail
			? {
					description: advisory.description ?? undefined,
					cvss_score: cvssScore(advisory),
					cwes: (advisory.cwes ?? []).map((cwe: any) => cwe.cwe_id),
					references: (advisory.references ?? []).map((ref: any) => ref.url),
				}
			: {}),
	};
}

export function compactCodeScanningAlert(alert: any, detail = false) {
	const rule = alert.rule ?? {};
	const instance = alert.most_recent_instance ?? {};
	const location = instance.location ?? {};
	return {
		number: alert.number,
		state: alert.state,
		// Two scales: `security_severity` (critical…low) is set only for security
		// rules, while `severity` (error, warning, note) is set for every rule.
		security_severity: rule.security_severity_level ?? undefined,
		severity: rule.severity ?? undefined,
		rule: rule.id,
		rule_name: rule.name ?? undefined,
		rule_description: rule.description ?? undefined,
		tool: alert.tool?.name,
		path: location.path,
		start_line: location.start_line,
		end_line: location.end_line ?? undefined,
		message: instance.message?.text ?? undefined,
		ref: instance.ref ?? undefined,
		commit_sha: instance.commit_sha ?? undefined,
		created_at: alert.created_at,
		updated_at: alert.updated_at ?? undefined,
		fixed_at: alert.fixed_at ?? undefined,
		dismissed_at: alert.dismissed_at ?? undefined,
		dismissed_by: login(alert.dismissed_by),
		dismissed_reason: alert.dismissed_reason ?? undefined,
		dismissed_comment: alert.dismissed_comment ?? undefined,
		url: alert.html_url,
		...(detail
			? {
					start_column: location.start_column ?? undefined,
					end_column: location.end_column ?? undefined,
					classifications: instance.classifications?.length
						? instance.classifications
						: undefined,
					rule_full_description: rule.full_description || undefined,
					rule_tags: rule.tags?.length ? rule.tags : undefined,
					rule_help: rule.help || undefined,
				}
			: {}),
	};
}

/**
 * Where a secret was found. A commit location carries a file and line range;
 * every other kind (an issue title, a PR comment, a wiki commit and so on) is
 * identified only by an API URL, so that is what is kept for those.
 */
export function compactSecretLocation(location: any) {
	return {
		type: location?.type,
		...compactLocationDetails(location?.details),
	};
}

function compactLocationDetails(details: any) {
	if (!details) {
		return undefined;
	}
	if (details.path) {
		return {
			path: details.path,
			start_line: details.start_line ?? undefined,
			end_line: details.end_line ?? undefined,
			commit_sha: details.commit_sha ?? undefined,
		};
	}
	const urlKey = Object.keys(details).find((key) => key.endsWith("_url"));
	return urlKey ? { api_url: details[urlKey] } : undefined;
}

export function compactSecretScanningAlert(alert: any) {
	return {
		number: alert.number,
		state: alert.state,
		secret_type: alert.secret_type,
		secret_type_display_name: alert.secret_type_display_name ?? undefined,
		validity: alert.validity ?? undefined,
		publicly_leaked: alert.publicly_leaked ?? undefined,
		multi_repo: alert.multi_repo ?? undefined,
		first_location: compactLocationDetails(alert.first_location_detected),
		has_more_locations: alert.has_more_locations ?? undefined,
		resolution: alert.resolution ?? undefined,
		resolved_at: alert.resolved_at ?? undefined,
		resolved_by: login(alert.resolved_by),
		resolution_comment: alert.resolution_comment ?? undefined,
		push_protection_bypassed: alert.push_protection_bypassed ?? undefined,
		push_protection_bypassed_by: login(alert.push_protection_bypassed_by),
		created_at: alert.created_at,
		updated_at: alert.updated_at ?? undefined,
		url: alert.html_url,
	};
}

export function compactRepositoryAdvisory(advisory: any, detail = false) {
	return {
		ghsa_id: advisory.ghsa_id,
		cve_id: advisory.cve_id ?? undefined,
		state: advisory.state,
		severity: advisory.severity ?? undefined,
		summary: advisory.summary,
		// GitHub attaches `submission` only to advisories that arrived through
		// private vulnerability reporting.
		reported_privately: advisory.submission ? true : undefined,
		author: login(advisory.author),
		publisher: login(advisory.publisher),
		vulnerabilities: (advisory.vulnerabilities ?? []).map((v: any) => ({
			ecosystem: v.package?.ecosystem,
			package: v.package?.name,
			vulnerable_version_range: v.vulnerable_version_range ?? undefined,
			patched_versions: v.patched_versions ?? undefined,
		})),
		created_at: advisory.created_at,
		updated_at: advisory.updated_at,
		published_at: advisory.published_at ?? undefined,
		closed_at: advisory.closed_at ?? undefined,
		withdrawn_at: advisory.withdrawn_at ?? undefined,
		url: advisory.html_url,
		...(detail
			? {
					description: advisory.description ?? undefined,
					cvss_score: cvssScore(advisory),
					cwe_ids: advisory.cwe_ids?.length ? advisory.cwe_ids : undefined,
					credits: (advisory.credits_detailed ?? []).map((credit: any) => ({
						login: login(credit.user),
						type: credit.type,
					})),
					collaborators: (advisory.collaborating_users ?? []).map(login),
				}
			: {}),
	};
}
