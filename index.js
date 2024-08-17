import core from '@actions/core';
import github from '@actions/github';
import parseDiff from 'parse-diff';

/**
 * 
 * @param {parseDiff.File[]} parsedDiff 
 */
function getCommentsToAdd(parsedDiff) {
    const comments = parsedDiff.reduce((acc, file) => {
        let diffRelativePosition = 0;
        return acc.concat(file.chunks.reduce((accc, chunk, i) => {
            if (i !== 0) {
                diffRelativePosition++;
            }
            return accc.concat(chunk.changes.map(change => {
                return {
                    ...change,
                    relativePosition: ++diffRelativePosition
                }
            }).filter(change => (change.type !== 'normal' && !change.content.includes("No newline at end of file"))).map((change, i, arr) => {
                if (change.type === 'add') {
                    if (arr[i - 1].type === 'add' && change.ln === arr[i - 1].ln + 1 && arr[i - 1].content !== "+") {
                        return null
                    }
                    if (i > 0 && arr[i - 1].type === 'del' && change.ln === arr[i - 1].ln) {
                        return {
                            path: file.from,
                            position: change.relativePosition,
                            line: change.ln,
                            body: `**${file.from}** added. This is a review comment.`,
                            change,
                            previously: arr[i - 1].content
                        }
                    }
                    return {
                        path: file.from,
                        position: change.relativePosition,
                        line: change.ln,
                        body: `**${file.from}** added. This is a review comment.`,
                        change
                    }
                }

                if (change.type === 'del' && change.ln === arr[i + 1].ln && arr[i + 1].type === 'add') {
                    return null
                }

                return {
                    path: file.from,
                    position: change.relativePosition,
                    line: change.ln,
                    body: `**${file.from}** changed to **${file.to}**. This is a review comment.`,
                    change
                }
            }).filter(i => i))
        }, []))
    }, [])

    function printJSON() {
        core.info(JSON.stringify(comments, null, 2))
    }

    return {
        raw: comments,
        comments: comments.map(i => {
            return {
                path: i.path,
                // position: i.position,
                line: i.line,
                body: i.body
            }
        }),
        printJSON
    }
}

/**
 * @typedef {import("@actions/github/lib/utils").GitHub} GitHub
 * @param {parseDiff.File[]} parsedDiff 
 * @param {InstanceType<GitHub>} octokit
 */
async function addReviewComments(parsedDiff, octokit) {
    await octokit.rest.pulls.createReview({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: github.context.payload.pull_request.number,
        body: `Code Review by better`,
        event: 'COMMENT',
        comments: getCommentsToAdd(parsedDiff).comments
    })
}
async function run() {
    try {
        core.info('running action...');
        const token = core.getInput('repo-token');
        const octokit = github.getOctokit(token);

        if (github.context.payload.pull_request) {
            const pullRequest = await octokit.rest.pulls.get({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                pull_number: github.context.payload.pull_request.number,
                headers: {
                    accept: 'application/vnd.github.diff',
                }
            })
            const parsedDiff = parseDiff(pullRequest.data);
            core.info(JSON.stringify(parsedDiff, null, 2));

            // await octokit.rest.pulls.createReview({
            //     owner: github.context.repo.owner,
            //     repo: github.context.repo.repo,
            //     pull_number: github.context.payload.pull_request.number,
            //     body: `Code Review by better`,
            //     event: 'COMMENT',
            //     comments: [
            //         {
            //             path: 'index.js',
            //             position: 5,
            //             body: `Code Review by better`,
            //         }
            //     ]
            // })

            getCommentsToAdd(parsedDiff).printJSON();
            await addReviewComments(parsedDiff, octokit);
        }
    } catch (error) {
        core.error(error);
        core.setFailed(error.message);
    }
}

run();