import core from '@actions/core';
import github, { context } from '@actions/github';
import parseDiff from 'parse-diff';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';

const aDiff = z.object({
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
    previously: z.string().optional(),
    suggestions: z.string().optional(),
});

const diffPayloadSchema = z.object(
    {
        commentsToAdd: z.array(aDiff)
    }
);

/**
 * @typedef {z.infer<typeof aDiff>[]} rawCommentsPayload
 * @typedef {z.infer<typeof diffPayloadSchema>} suggestionsPayload
 * @typedef {{ path: string, line: number, body: string }[]} CommentsPayload
 */

/**
 * 
 * @param {parseDiff.File[]} parsedDiff 
 */
function getCommentsToAdd(parsedDiff) {
    /**
     * @returns {rawCommentsPayload}
     */
    const comments = () => parsedDiff.reduce((acc, file) => {
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
                        if (change.content === "+" || change.content === "-") {
                            return null
                        }

                        if (change.type === 'add') {
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

    /**
     * @typedef
     * @param {rawCommentsPayload} rawComments
     * @param {OpenAI} openAI
     * @param {string} rules
     */
    const getSuggestions = async (rawComments, openAI, rules) => {
        const result = await openAI.beta.chat.completions.parse({
            model: 'gpt-4o-mini-2024-07-18',
            messages: [
                {
                    role: 'system',
                    content: `You are a code reviewer.
                    The user will provide you with a diff payload and some rules (they are separated by --), and you have to make suggestions on what can be improved by looking at the diff changes.
                    Take the user input diff payload and analyze the changes from the "content" property (ignore the first "+" or "-" character at the start of the string because that's just a diff character) of the payload and suggest some improvements (if an object contains "previously" property, compare it against the "content" property and consider that as well to make suggestions).
                    If you think there are no improvements to be made, don't return **that** object from the payload.
                    Rest, **return everything as it is (in the same order)** along with your suggestions.
                    NOTE: 
                    - If something is deleted (type: "del"), compare it with what's added (type: "add") in place of it. If it's completely different, ignore the deleted part and give suggestions based on the added (type: "add") part.
                    - Only modify/add the "suggestions" property (if required).
                    - DO NOT modify the value of any other property. Return them as they are in the input.
                    - Keep the suggestions precise and to the point (in a constructive way).
                    - Suggestions should be inclusive of the rules (if any) provided by the user.
                    - Rules are not exhaustive, so use you own judgement as well.
                    - Rules start with and are separated by --`,
                },
                {
                    role: 'user',
                    content: `Code review the following PR diff payload${rules ? ` by including the following rules: ${rules}` : ''}. Here's the diff payload:
                    ${JSON.stringify(rawComments, null, 2)}`
                }
            ],
            response_format: zodResponseFormat(diffPayloadSchema, 'json_diff_response')
        })

        return result.choices[0].message.parsed
    }

    return {
        raw: comments,
        getSuggestions,
        /**
         * @param {suggestionsPayload} suggestions
         * @returns {CommentsPayload}
         */
        comments: (suggestions) => suggestions.commentsToAdd.filter(i => {
            return i["suggestions"]
        }).map(i => {
            return {
                path: i.path,
                // position: i.position,
                line: i.line,
                body: i.suggestions
            }
        }),
    }
}

/**
 * @typedef {import("@actions/github/lib/utils").GitHub} GitHub
 * @param {parseDiff.File[]} parsedDiff
 * @param {diffPayloadSchema} suggestions
 * @param {InstanceType<GitHub>} octokit
 */
async function addReviewComments(parsedDiff, suggestions, octokit) {
    return await octokit.rest.pulls.createReview({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: github.context.payload.pull_request.number,
        body: `Code Review`,
        event: 'COMMENT',
        comments: getCommentsToAdd(parsedDiff).comments(suggestions),
    })
}

async function run() {
    try {
        core.info('Retrieving tokens and inputs...');

        const rules = core.getInput('rules');
        const token = core.getInput('repo-token');
        const modelToken = core.getInput('ai-model-api-key');
        const octokit = github.getOctokit(token);

        core.info('Initializing AI model...');

        const openAI = new OpenAI({
            apiKey: modelToken
        })

        if (github.context.payload.pull_request) {
            core.info('Fetching pull request details...');
            const pullRequest = await octokit.rest.pulls.get({
                owner: github.context.repo.owner,
                repo: github.context.repo.repo,
                pull_number: github.context.payload.pull_request.number,
                headers: {
                    accept: 'application/vnd.github.diff',
                }
            });

            core.info(`Reviewing pull request ${pullRequest.url}...`);
            const parsedDiff = parseDiff(pullRequest.data);
            const rawComments = getCommentsToAdd(parsedDiff).raw();

            core.info('Generating suggestions...');
            const suggestions = await getCommentsToAdd(parsedDiff).getSuggestions(rawComments, openAI, rules);

            core.info('Adding review comments...');
            const review = await addReviewComments(parsedDiff, suggestions, octokit);

            const output = {
                ['code-review-details']: {
                    review,
                    suggestions,
                    raw: rawComments,
                    pullRequest,
                    context: github.context
                },
                ['pr-id']: github.context.payload.pull_request.number
            }

            core.setOutput('code-review-details', output['code-review-details']);
            core.setOutput('pr-id', output['pr-id']);

            core.info('Code review complete!');
        } else {
            core.warning('Not a pull request, skipping...');
        }
    } catch (error) {
        core.error(error);
        core.setFailed(error.message);
    }
}

run();