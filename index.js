import core from '@actions/core';
import github from '@actions/github';
import parseDiff from 'parse-diff';

async function run() {
    try {
        core.info('running action...');
        const token = core.getInput('repo-token');
        const octokit = github.getOctokit(token);
        const stargazers = await octokit.rest.activity.listStargazersForRepo({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo
        });
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
            core.info(JSON.stringify(pullRequest.data, null, 2));
            core.info(JSON.stringify(parsedDiff, null, 2));

            // core.info(JSON.stringify(
            //     parsedDiff.reduce((acc, file) => {
            //         return acc.concat(file.chunks.reduce((accc, chunk) => {
            //             return accc.concat(chunk.changes.filter(change => (change.type !== 'normal' && !change.content.includes("No newline at end of file"))).map((change, i, arr) => {
            //                 if (change.type === 'add') {
            //                     if (i > 0 && arr[i - 1].type === 'del' && change.ln === arr[i - 1].ln) {
            //                         return {
            //                             path: file.from,
            //                             position: change.ln,
            //                             body: `**${file.from}** added. This is a review comment.`,
            //                             change,
            //                             previously: arr[i - 1].content
            //                         }
            //                     }
            //                     return {
            //                         path: file.from,
            //                         position: change.ln,
            //                         body: `**${file.from}** added. This is a review comment.`,
            //                         change
            //                     }
            //                 }

            //                 if (change.type === 'del' && change.ln === arr[i + 1].ln && arr[i + 1].type === 'add') {
            //                     return null
            //                 }

            //                 return {
            //                     path: file.from,
            //                     position: change.ln,
            //                     body: `**${file.from}** changed to **${file.to}**. This is a review comment.`,
            //                     change
            //                 }
            //             }).filter(i => i))
            //         }, []))
            //     }, []),
            //     null, 2
            // ))

            await octokit.rest.pulls.createReview({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                pull_number: github.context.payload.pull_request.number,
                body: `Code Review by better`,
                event: 'COMMENT',
                comments: parsedDiff.reduce((acc, file) => {
                    return acc.concat(file.chunks.reduce((accc, chunk) => {
                        return accc.concat(chunk.changes.filter(change => (change.type !== 'normal' && !change.content.includes("No newline at end of file"))).map((change, i, arr) => {
                            if (change.type === 'add') {
                                if (i > 0 && arr[i - 1].type === 'del' && change.ln === arr[i - 1].ln) {
                                    return {
                                        path: file.from,
                                        position: change.ln,
                                        body: `**${arr[i - 1].content}** removed and **${change.content}** added. This is a review comment.`,
                                        change,
                                        previously: arr[i - 1].content
                                    }
                                }
                                return {
                                    path: file.from,
                                    position: change.ln,
                                    body: `**${change.content}** added. This is a review comment.`,
                                    change
                                }
                            }

                            if (change.type === 'del' && change.ln === arr[i + 1].ln && arr[i + 1].type === 'add') {
                                return null
                            }

                            return {
                                path: file.from,
                                position: change.ln,
                                body: `**${file.from}** modified to **${file.to}** and the content changed to **${change.content}**. This is a review comment.`,
                                change
                            }
                        }).filter(i => i).map(i => ({
                            path: i.path,
                            position: i.position,
                            body: i.body
                        })))
                    }, []))
                }, [])
            })
        }
        const time = (new Date()).toTimeString();
        core.info(`${time}, ${JSON.stringify(github.context.repo, null, 2)}, ${stargazers.data}`);
    } catch (error) {
        core.error(error);
        core.setFailed(error.message);
    }
}

run();