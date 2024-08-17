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
                pull_number: github.context.payload.pull_request.number
            })
            core.info(pullRequest);
        }
        const time = (new Date()).toTimeString();
        core.info(`${time}, ${github.context.repo}, ${stargazers.data}`);
    } catch (error) {
        core.error(error);
        core.setFailed(error.message);
    }
}

run();