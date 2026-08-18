import { Octokit } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";

const CustomOctokit = Octokit.plugin(paginateRest);

const STATUS_FIELD_ID = 125158268; // Status field
const STATUS_TO_BUCKET = {
  "Ready for Release": "readyForRelease",
  "In QA": "inQa",
  "Ready for QA": "readyForQa",
  "In Review": "inReview",
  "Ready for PR Review": "readyForPrReview",
  "Changes Required": "changesRequired",
  "Doing": "doing",
};

const TEAM_MEMBERS = [
  "GTFalcao",
  "michelle0927",
  "dannyroosevelt",
  "s0s0physm",
  "ashwins01",
  "vetrivigneshwaran",
  "Priyadharshan-Pdm",
];

function githubHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_OAUTH_TOKEN}`,
    "X-GitHub-Api-Version": "2026-03-10",
  };
}

async function ghGet(url) {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    throw new Error(`GitHub API ${url} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function getItemsByColumn(client) {
  const q = "status:" + Object.keys(STATUS_TO_BUCKET).map((s) => `"${s}"`).join(",");

  const items = await client.paginate("GET /orgs/PipedreamHQ/projectsV2/11/items", {
    per_page: 100,
    fields: STATUS_FIELD_ID,
    q,
  });

  const buckets = {
    readyForRelease: [],
    inQa: [],
    readyForQa: [],
    inReview: [],
    readyForPrReview: [],
    changesRequired: [],
    doing: [],
  };
  for (const item of items) {
    const status = item.fields?.[0]?.value?.name?.raw;
    const bucket = STATUS_TO_BUCKET[status];
    if (bucket) buckets[bucket].push(item);
  }
  return buckets;
}

async function enrichItems(categorizedItems) {
  await Promise.all(
    Object.values(categorizedItems).flat().map(async (item) => {
      const content = item.content;
      let pr, prNumber, prReviewer;

      if (item.content_type === "PullRequest") {
        prNumber = content.number;
      }

      // get the attached PR for issues
      if (item.content_type === "Issue") {
        const timeline = await ghGet(
          `https://api.github.com/repos/PipedreamHQ/pipedream/issues/${content.number}/timeline`
        );
        const timelineItem = timeline.find(
          (i) => i.event === "cross-referenced" && i.source?.issue?.pull_request
        );
        if (timelineItem) {
          prNumber = timelineItem.source.issue.pull_request.url.split("/").pop();
        }
      }

      if (prNumber) {
        pr = await ghGet(`https://api.github.com/repos/PipedreamHQ/pipedream/pulls/${prNumber}`);
        const reviewerObj = pr.requested_reviewers.find((r) => TEAM_MEMBERS.includes(r.login));
        if (reviewerObj) {
          prReviewer = reviewerObj.login;
        }
      }

      const author = pr ? pr.user.login : content.user.login;

      let reviews = [];
      let commits = [];
      if (prNumber) {
        reviews = await ghGet(`https://api.github.com/repos/PipedreamHQ/pipedream/pulls/${prNumber}/reviews`);
        commits = await ghGet(`https://api.github.com/repos/PipedreamHQ/pipedream/pulls/${prNumber}/commits`);
      }

      let lastAuthorCommitDate;
      if (commits.length) {
        const lastAuthorCommit = commits.reverse().find((c) => c.committer && c.committer.login === author);
        if (lastAuthorCommit) {
          lastAuthorCommitDate = lastAuthorCommit.commit.committer.date;
        }
      }
      const lastReview = reviews.slice().reverse().find((r) => TEAM_MEMBERS.includes(r.user.login) && r.user.login !== author);
      const reviewer = prReviewer || lastReview?.user?.login;
      const approved = lastReview && lastReview.state === "APPROVED";

      Object.assign(item, {
        id: content.id,
        title: content.title,
        url: content.html_url,
        labels: (content.labels ?? []).map((l) => l.name),
        author,
        reviewer,
        approved,
        lastUpdated: item.updated_at,
        lastAuthorCommitDate,
        lastReviewDate: lastReview?.submitted_at,
        assignee: item.content.assignee?.login,
      });
    })
  );

  const trimmed = {};
  for (const [bucket, items] of Object.entries(categorizedItems)) {
    trimmed[bucket] = items.map((item) => ({
      id: item.id,
      title: item.title,
      url: item.url,
      labels: item.labels,
      author: item.author,
      reviewer: item.reviewer,
      approved: item.approved,
      lastUpdated: item.lastUpdated,
      lastAuthorCommitDate: item.lastAuthorCommitDate,
      lastReviewDate: item.lastReviewDate,
      assignee: item.assignee,
    }));
  }
  return trimmed;
}

function applyReadyForRelease(items) {
  items.forEach((item) => {
    item.action = item.approved ? "Merge the PR" : "Approve the PR";
    item.actionUser = item.approved && TEAM_MEMBERS.includes(item.author) ? item.author : item.reviewer;
  });
  return items;
}

function applyInQa(items) {
  items.forEach((item) => {
    const highPriority = item.labels.includes("HIGH PRIORITY");
    item.action = "Finish QA";
    item.actionUser = highPriority
      ? "mariano-pd"
      : TEAM_MEMBERS.includes(item.author)
        ? item.author
        : item.reviewer;
  });
  return items;
}

function applyReadyForQa(items) {
  items.forEach((item) => {
    const highPriority = item.labels.includes("HIGH PRIORITY");
    item.action = "Start QA";
    item.actionUser = highPriority
      ? "mariano-pd"
      : TEAM_MEMBERS.includes(item.author)
        ? item.author
        : item.reviewer;
  });
  return items;
}

function applyInReview(items) {
  items.forEach((item) => {
    item.action = "Finish Review";
    item.actionUser = item.reviewer;
  });
  return items;
}

function applyReadyForPrReview(items) {
  items.forEach((item) => {
    item.action = "Review PR";
    item.actionUser = item.reviewer;
  });
  return items;
}

function applyChangesRequired(items) {
  items.forEach((item) => {
    if (TEAM_MEMBERS.includes(item.author)) {
      item.action = "Complete Changes";
      item.actionUser = item.author;
      return;
    }

    const lastReviewDate = Date.parse(item.lastReviewDate);
    const committedSinceReview = Date.parse(item.lastAuthorCommitDate) > lastReviewDate;
    const olderThan7Days = lastReviewDate < Date.now() - 7 * 24 * 60 * 60 * 1000;

    if (committedSinceReview) {
      item.action = "Review";
    } else if (!olderThan7Days) {
      item.action = "Wait for user to complete changes";
    } else {
      item.action = "Complete Changes";
    }
    item.actionUser = item.reviewer;
  });
  return items;
}

function applyDoing(items) {
  items.forEach((item) => {
    item.action = "Complete issue";
    item.actionUser = item.assignee;
  });
  return items;
}

function combineAndSortByUser(data) {
  return Object.entries(data).reduce((result, [status, statusItems]) => {
    statusItems.forEach((item) => {
      (result[item.actionUser] ??= {});
      (result[item.actionUser][status] ??= []).push(item);
    });
    return result;
  }, {});
}

const RED_LABELS = ["blocked", "missing scopes", "paid-account-needed"];
const BLUE_LABELS = ["prioritized"];
const HIGHLIGHT_LABELS = ["high priority"];

function labelStyle(label) {
  const lower = label.toLowerCase();
  if (lower.includes("blocked") || RED_LABELS.includes(lower)) return "color:red";
  if (BLUE_LABELS.includes(lower)) return "color:blue";
  if (HIGHLIGHT_LABELS.includes(lower)) return "background-color:yellow";
  return null;
}

function formatLabels(labels) {
  return labels
    .map((label) => {
      const style = labelStyle(label);
      return style ? `<span style="${style}">${label}</span>` : label;
    })
    .join(", ");
}

function generateHtml(data) {
  const humanizeStatus = (status) =>
    status
      .replace(/([A-Z])/g, " $1")
      .replace(/^./, (c) => c.toUpperCase())
      .replace(/\bPr\b/g, "PR")
      .replace(/\bQa\b/g, "QA");

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>GitHub Work Queue</title>
<style>
body {
  font-family: Arial, Helvetica, sans-serif;
  background: #f4f6f8;
  margin: 40px;
  color: #333;
}

.user {
  background: white;
  border-radius: 10px;
  padding: 24px;
  margin-bottom: 30px;
  box-shadow: 0 2px 10px rgba(0,0,0,.08);
}

.user h2 {
  margin-top: 0;
}

.status {
  margin-top: 24px;
}

.status h3 {
  color: white;
  padding: 10px 14px;
  border-radius: 6px;
  display: inline-block;
  margin-bottom: 10px;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th {
  background: #f5f5f5;
  text-align: left;
}

th, td {
  padding: 8px;
  border: 1px solid #ddd;
}

.action {
  font-weight: bold;
}

a {
  color: #0366d6;
  text-decoration: none;
}
</style>
</head>

<body>

<h1>GitHub Work Queue</h1>

${Object.entries(data).map(([user, statuses]) => `
<div class="user">

<h2>${user}</h2>

${Object.entries(statuses).map(([status, items]) => `
<div class="status">

<h3 style="background:#666">
${humanizeStatus(status)}
</h3>

<table>
<tr>
  <th>Action</th>
  <th>Title</th>
  <th>Author</th>
  <th>Labels</th>
</tr>

${items.map((item) => `
<tr>
  <td class="action">${item.action}</td>
  <td><a href="${item.url}">${item.title}</a></td>
  <td>${item.author}</td>
  <td>${formatLabels(item.labels)}</td>
</tr>
`).join("")}

</table>

</div>
`).join("")}

</div>
`).join("")}

</body>
</html>
`;
}

export default async function handler(req, res) {
  try {
    const client = new CustomOctokit({ auth: process.env.GITHUB_OAUTH_TOKEN });

    const categorizedItems = await getItemsByColumn(client);
    const parsed = await enrichItems(categorizedItems);

    const byActionUser = combineAndSortByUser({
      readyForRelease: applyReadyForRelease(parsed.readyForRelease),
      inQa: applyInQa(parsed.inQa),
      readyForQa: applyReadyForQa(parsed.readyForQa),
      inReview: applyInReview(parsed.inReview),
      readyForPrReview: applyReadyForPrReview(parsed.readyForPrReview),
      changesRequired: applyChangesRequired(parsed.changesRequired),
      doing: applyDoing(parsed.doing),
    });

    res.setHeader("Content-Type", "text/html");
    res.status(200).send(generateHtml(byActionUser));
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
}
