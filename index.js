import core from '@actions/core';
import github from '@actions/github';
import parseDiff from 'parse-diff';

/**
 * prompt
 * now what I want you to do is, take this diff payload and analyze the changes from the "content" and "previously" properties of the payload and suggest some improvements. If you think there are no improvements to be made, don't return such object from the payload. Rest, return everything as it is (in the same order) along with your suggestions.
 */

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
            return accc.concat(
                chunk.changes.map(change => {
                    return {
                        ...change,
                        relativePosition: ++diffRelativePosition
                    }
                }).filter(change => (change.type !== 'normal' && !change.content.includes("No newline at end of file")))
                    .map((change, i, arr) => {
                        if (change.type === 'add') {
                            /**
                             * This code checks if the current change is an addition (change.type === 'add') that immediately follows another addition (arr[i - 1].type === 'add') on the next line (change.ln === arr[i - 1].ln + 1). If the previous addition is not a single "+" character (arr[i - 1].content !== "+"), it skips the current change by returning null.
                             */
                            if (arr[i - 1].type === 'add' && change.ln === arr[i - 1].ln + 1 && arr[i - 1].content !== "+") {
                                // might want to remove this check to be able to feed the data to AI
                                return null
                            }

                            /**
                             * It checks if the current change (change) is an addition that immediately follows a deletion (arr[i - 1].type === 'del') on the same line (change.ln === arr[i - 1].ln).
                             */
                            if (i > 0 && arr[i - 1].type === 'del' && change.ln === arr[i - 1].ln) {
                                return {
                                    path: file.from,
                                    position: change.relativePosition,
                                    line: change.ln,
                                    body: `**${change.content}** added. This is a review comment.`,
                                    change,
                                    previously: arr[i - 1].content
                                }
                            }

                            return {
                                path: file.from,
                                position: change.relativePosition,
                                line: change.ln,
                                body: `**${change.content}** added. This is a review comment.`,
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
                            body: `**${change.content}** modified. This is a review comment.`,
                            change
                        }
                    }).filter(i => i) /** filter out nulls */
            )
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
        const token = core.getInput('repo-token');
        const modelToken = core.getInput('ai-model-api-key');
        const octokit = github.getOctokit(token);
        
        if (github.context.payload.pull_request) {
            core.info('Reviewing pull request...');

            const pullRequest = await octokit.rest.pulls.get({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                pull_number: github.context.payload.pull_request.number,
                headers: {
                    accept: 'application/vnd.github.diff',
                }
            })

            const parsedDiff = parseDiff(pullRequest.data);

            getCommentsToAdd(parsedDiff).printJSON();
            await addReviewComments(parsedDiff, octokit);
        }
    } catch (error) {
        core.error(error);
        core.setFailed(error.message);
    }
}

run();