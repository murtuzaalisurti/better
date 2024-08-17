import core from '@actions/core';
import github from '@actions/github';

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
                    accept: 'application/vnd.github.v3.diff'
                }
            })
            core.info(JSON.stringify(pullRequest, null, 2));
        }
        const time = (new Date()).toTimeString();
        core.info(`${time}, ${JSON.stringify(github.context.repo, null, 2)}, ${stargazers.data}`);
    } catch (error) {
        core.error(error);
        core.setFailed(error.message);
    }
}

run();