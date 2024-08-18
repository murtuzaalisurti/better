import core from '@actions/core';
import github from '@actions/github';
import parseDiff from 'parse-diff';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';

/**
 * prompt
 * now what I want you to do is, take this diff payload and analyze the changes from the "content" and "previously" properties of the payload and suggest some improvements. If you think there are no improvements to be made, don't return such object from the payload. Rest, return everything as it is (in the same order) along with your suggestions.
 */

const diffPayloadSchema = z.object(
    {
        path: z.string(),
        position: z.number(),
        line: z.number(),
        body: z.string(),
        change: z.object({
            type: z.string(),
            add: z.boolean(),
            ln: z.number(),
            content: z.string(),
            relativePosition: z.number(),
        }),
        previously: z.string().isOptional(),
        suggestions: z.string().isOptional(),
    },
);
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

        const openAI = new OpenAI({
            apiKey: modelToken
        })

        console.log('calling openAI chat.completions.create')
        const aiResult = await openAI.chat.completions.create({
            model: 'gpt-4o-mini-2024-07-18',
            messages: [
                {
                    role: 'system',
                    content: 'I want you to act as a code reviewer. I will provide you with a diff payload and I want you to make suggestions on what can be improved by looking at the diff changes. Keep the suggestions precise and to the point (in a constructive way).',
                },
                {
                    role: 'user',
                    content: `Now what I want you to do is, take this diff payload and analyze the changes from the "content" and "previously" properties of the payload and suggest some improvements. If you think there are no improvements to be made, don't return **that** object from the payload. Rest, **return everything as it is (in the same order)** along with your suggestions. And, return the response in a json format. Here's the diff: [
  {
    "path": "index.js",
    "position": 3,
    "line": 1,
    "body": "**index.js** added. This is a review comment.",
    "change": {
      "type": "add",
      "add": true,
      "ln": 1,
      "content": "+console.log(\"Hey there, World! ----------\");",
      "relativePosition": 3
    },
    "previously": "-console.log(\"Hello, World!\");"
  },
  {
    "path": "index.js",
    "position": 5,
    "line": 3,
    "body": "**index.js** added. This is a review comment.",
    "change": {
      "type": "add",
      "add": true,
      "ln": 3,
      "content": "+(() => {",
      "relativePosition": 5
    }
  },
  {
    "path": "package.json",
    "position": 4,
    "line": 3,
    "body": "**package.json** added. This is a review comment.",
    "change": {
      "type": "add",
      "add": true,
      "ln": 3,
      "content": "+  \"version\": \"1.1.2\",",
      "relativePosition": 4
    },
    "previously": "-  \"version\": \"1.0.0\","
  },
  {
    "path": "package.json",
    "position": 7,
    "line": 6,
    "body": "**package.json** added. This is a review comment.",
    "change": {
      "type": "add",
      "add": true,
      "ln": 6,
      "content": "+    \"start\": \"node index.js\",",
      "relativePosition": 7
    }
  }
]`
                }
            ],
            // response_format: zodResponseFormat(diffPayloadSchema, 'json_diff_response')
        })

        console.log(JSON.stringify(aiResult.choices[0].message, null, 2))

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

            // getCommentsToAdd(parsedDiff).printJSON();
            // await addReviewComments(parsedDiff, octokit);
        }
    } catch (error) {
        core.error(error);
        core.setFailed(error.message);
    }
}

run();