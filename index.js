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

            core.info(JSON.stringify(
                parsedDiff.reduce((acc, file) => {
                    return acc.concat(file.chunks.reduce((accc, chunk) => {
                        return accc.concat(chunk.changes.filter(change => (change.type !== 'normal' && !change.content.includes("No newline at end of file"))).map(change => {
                            core.info(`${change.content.includes("No newline at end of file")}`);
                            return {
                                path: file.from,
                                position: change.ln,
                                body: `**${file.from}** changed to **${file.to}**. This is a review comment.`,
                                change
                            }
                        }))
                    }, []))
                }, []),
                null, 2
            ))

            // await octokit.rest.pulls.createReview({
            //     owner: github.context.repo.owner,
            //     repo: github.context.repo.repo,
            //     pull_number: github.context.payload.pull_request.number,
            //     body: `Code Review by better`,
            //     event: 'COMMENT',
            //     comments: parsedDiff.reduce((acc, file) => {
            //         return acc.concat(file.chunks.reduce((accc, chunk) => {
            //             return accc.concat(chunk.changes.filter(change => change.type !== 'normal').map(change => {
            //                 return {
            //                     path: file.from,
            //                     position: change.ln,
            //                     body: `**${file.from}** changed to **${file.to}**. This is a review comment.`
            //                 }
            //             }))
            //         }, []))
            //     }, [])
            // })
        }
        const time = (new Date()).toTimeString();
        core.info(`${time}, ${JSON.stringify(github.context.repo, null, 2)}, ${stargazers.data}`);
    } catch (error) {
        core.error(error);
        core.setFailed(error.message);
    }
}

run();