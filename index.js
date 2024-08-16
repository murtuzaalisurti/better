import core from '@actions/core';
import github from '@actions/github';

async function run() {
    console.log('running...');
    try {
        const token = core.getInput('repo-token');
        const octokit = github.getOctokit(token);
        // const stargazers = await octokit.rest.activity.listStargazersForRepo();
        const time = (new Date()).toTimeString();
        console.log(github.context.repo);
        core.setOutput("time", time);
    } catch (error) {
        core.info(error);
        core.error(error);
        core.setFailed(error.message);
    }
}

run();