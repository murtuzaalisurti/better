import core from "@actions/core";
import github from "@actions/github";
import parseDiff from "parse-diff";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { aDiff, diffPayloadSchema } from "./utils/types.js";
import { DEFAULT_MODEL } from "./utils/constants.js";

/**
 * @typedef {import("@actions/github/lib/utils").GitHub} GitHub
 * @typedef {z.infer<typeof aDiff>[]} rawCommentsPayload
 * @typedef {z.infer<typeof diffPayloadSchema>} suggestionsPayload
 * @typedef {{ path: string, line: number, body: string }[]} CommentsPayload
 * @typedef {InstanceType<GitHub>} OctokitApi
 * @typedef {parseDiff.File[]} ParsedDiff
 * @typedef {{ body: string | null }} PullRequestContext
 * @typedef {{
 *  info: (message: string) => void,
 *  warning: (message: string) => void,
 *  error: (error: string) => void
 * }} Logger
 */

/**
 * @param {string} name
 * @returns {string}
 */
function getModelName(name) {
    return name !== "" ? name : DEFAULT_MODEL.name;
}

function extractComments() {
    /**
     * @param {ParsedDiff} parsedDiff
     * @returns {rawCommentsPayload}
     */
    const rawComments = parsedDiff =>
        parsedDiff.reduce((acc, file) => {
            const filePath = file.deleted ? file.from : file.to;
            let diffRelativePosition = 0;
            return acc.concat(
                file.chunks.reduce((accc, chunk, i) => {
                    if (i !== 0) {
                        diffRelativePosition++;
                    }
                    return accc.concat(
                        chunk.changes
                            .map(change => {
                                return {
                                    ...change,
                                    relativePosition: ++diffRelativePosition,
                                };
                            })
                            .filter(
                                change =>
                                    change.type !== "normal" && !change.content.includes("No newline at end of file")
                            )
                            .map((change, i, arr) => {
                                if (change.content === "+" || change.content === "-") {
                                    return null;
                                }

                                if (change.type === "add") {
                                    /**
                                     * It checks if the current change (change) is an addition that immediately follows a deletion (arr[i - 1].type === 'del') on the same line (change.ln === arr[i - 1].ln).
                                     */
                                    if (i > 0 && arr[i - 1].type === "del" && change.ln === arr[i - 1].ln) {
                                        return {
                                            path: filePath,
                                            position: change.relativePosition,
                                            line: change.ln,
                                            change,
                                            previously: arr[i - 1].content,
                                        };
                                    }

                                    return {
                                        path: filePath,
                                        position: change.relativePosition,
                                        line: change.ln,
                                        change,
                                    };
                                }

                                if (
                                    i < arr.length - 1 &&
                                    change.type === "del" &&
                                    change.ln === arr[i + 1].ln &&
                                    arr[i + 1].type === "add"
                                ) {
                                    return null;
                                }

                                return {
                                    path: filePath,
                                    position: change.relativePosition,
                                    line: change.ln,
                                    change,
                                };
                            })
                            .filter(i => i) /** filter out nulls */
                    );
                }, [])
            );
        }, []);

    /**
     * @param {suggestionsPayload} suggestions
     * @returns {CommentsPayload}
     */
    const commentsWithSuggestions = suggestions =>
        suggestions.commentsToAdd
            .filter(i => i["suggestions"])
            .map(i => {
                return {
                    path: i.path,
                    // position: i.position,
                    line: i.line,
                    body: i.suggestions,
                };
            });

    return {
        raw: rawComments,
        comments: commentsWithSuggestions,
    };
}

/**
 * @param {rawCommentsPayload} rawComments
 * @param {OpenAI} openAI
 * @param {string} rules
 * @param {string} modelName
 * @param {PullRequestContext} pullRequestContext
 */
async function getSuggestions(rawComments, openAI, rules, modelName, pullRequestContext) {
    const { error } = log({ withTimestamp: true }); // eslint-disable-line no-use-before-define

    try {
        const result = await openAI.beta.chat.completions.parse({
            model: getModelName(modelName),
            messages: [
                {
                    role: "system",
                    content: `You are a highly experienced software engineer and code reviewer with a focus on code quality, maintainability, and adherence to best practices.
                    Your goal is to provide thorough, constructive, and actionable feedback to help developers improve their code.
                    You consider various aspects, including readability, efficiency, and security.
                    The user will provide you with a diff payload and some rules on how the code should be (they are separated by --), and you have to make suggestions on what can be improved by looking at the diff changes. You might be provided with a PR description for more context (most probably in markdown format).
                    Take the user input diff payload and analyze the changes from the "content" property (ignore the first "+" or "-" character at the start of the string because that's just a diff character) of the payload and suggest some improvements (if an object contains "previously" property, compare it against the "content" property and consider that as well to make suggestions).
                    If you think there are no improvements to be made, don't return **that** object from the payload.
                    Rest, **return everything as it is (in the same order)** along with your suggestions. Ignore formatting issues.
                    IMPORTANT: 
                    - Don't be lazy.
                    - Only make suggestions when they are significant, relevant and add value to the code changes.
                    - If something is deleted (type: "del"), compare it with what's added (type: "add") in place of it. If it's completely different, ignore the deleted part and give suggestions based on the added (type: "add") part.
                    - Only modify/add the "suggestions" property (if required).
                    - DO NOT modify the value of any other property. Return them as they are in the input.
                    - Make sure the suggestion positions are accurate as they are in the input and suggestions are related to the code changes on those positions (see "content" or "previously" (if it exists) property).
                    - If there is a suggestion which is similar across multiple positions, only suggest that change at any one of those positions.
                    - Keep the suggestions precise and to the point (in a constructive way).
                    - If possible, add references to some really good resources like stackoverflow or from programming articles, blogs, etc. for suggested code changes. Keep the references in context of the programming language you are reviewing.
                    - Suggestions should be inclusive of the rules (if any) provided by the user.
                    - You can also give suggested code changes in markdown format.
                    - If there are no suggestions, please don't spam with "No suggestions".
                    - Rules are not exhaustive, so use you own judgement as well.
                    - Rules start with and are separated by --`,
                },
                {
                    role: "user",
                    content: `Code review the following PR diff payload${rules ? ` by including the following rules: ${rules}` : ""}. Here's the diff payload:
                    ${JSON.stringify(rawComments, null, 2)}
                    ${pullRequestContext.body ? `\nAlso, here's the PR description on what it's trying to do to give some more context: ${pullRequestContext.body})` : ""}`,
                },
            ],
            response_format: zodResponseFormat(diffPayloadSchema, "json_diff_response"),
        });

        const { message } = result.choices[0];

        if (message.refusal) {
            throw new Error(`the model refused to generate suggestions - ${message.refusal}`);
        }

        return message.parsed;
    } catch (err) {
        if (err.constructor.name == "LengthFinishReasonError") {
            error(`Too many tokens: ${err.message}`);
            core.setFailed(`Too many tokens: ${err.message}`);
        } else {
            error(`Could not generate suggestions: ${err.message}`);
            core.setFailed(`Could not generate suggestions: ${err.message}`);
        }
    }
}

/**
 * @param {rawCommentsPayload} rawComments
 * @param {CommentsPayload} comments
 * @returns {CommentsPayload}
 */
function filterPositionsNotPresentInRawPayload(rawComments, comments) {
    return comments.filter(comment =>
        rawComments.some(rawComment => rawComment.path === comment.path && rawComment.line === comment.line)
    );
}

/**
 * @param {suggestionsPayload} suggestions
 * @param {OctokitApi} octokit
 * @param {rawCommentsPayload} rawComments
 */
async function addReviewComments(suggestions, octokit, rawComments) {
    const comments = filterPositionsNotPresentInRawPayload(rawComments, extractComments().comments(suggestions));

    await octokit.rest.pulls.createReview({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: github.context.payload.pull_request.number,
        body: `Code Review`,
        event: "COMMENT",
        comments,
    });
}

/**
 * @param {OctokitApi} octokit
 * @param {{ mode: 'diff' | 'json' }} options
 */
async function getPullRequestDetails(octokit, { mode }) {
    let AcceptFormat = "application/vnd.github.raw+json";

    if (mode === "diff") AcceptFormat = "application/vnd.github.diff";
    if (mode === "json") AcceptFormat = "application/vnd.github.raw+json";

    return await octokit.rest.pulls.get({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: github.context.payload.pull_request.number,
        headers: {
            accept: AcceptFormat,
        },
    });
}

/**
 * @param {OctokitApi} octokit
 */
async function getAllReviewsForPullRequest(octokit) {
    return await octokit.rest.pulls.listReviews({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: github.context.payload.pull_request.number,
    });
}

/**
 * @param {OctokitApi} octokit
 * @param {number} review_id
 */
async function getAllCommentsUnderAReview(octokit, review_id) {
    return await octokit.rest.pulls.listCommentsForReview({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: github.context.payload.pull_request.number,
        review_id,
    });
}

/**
 * @param {OctokitApi} octokit
 * @param {number} comment_id
 */
async function deleteComment(octokit, comment_id) {
    await octokit.rest.pulls.deleteReviewComment({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        comment_id,
    });
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function getBooleanValue(value) {
    if (!value || value === "") return false;
    return value.toLowerCase() === "true";
}

/**
 * @param {{ withTimestamp: boolean }} options
 * @returns {Logger}
 */
function log({ withTimestamp = true }) {
    /**
     * @param {string} str
     * @returns {string}
     */
    const getLogText = str => (withTimestamp ? `[${new Date().toISOString()}]: ${str}` : str);
    return {
        info: message => core.info(getLogText(message)),
        warning: message => core.warning(getLogText(message)),
        error: error => core.error(getLogText(error)),
    };
}

async function run() {
    const { info, warning, error } = log({ withTimestamp: true });

    try {
        info("Retrieving tokens and inputs...");

        const deleteExistingReviews = core.getInput("delete-existing-review-by-bot");
        const rules = core.getInput("rules");
        const token = core.getInput("repo-token");
        const modelName = core.getInput("ai-model-name");
        const modelToken = core.getInput("ai-model-api-key");
        const octokit = github.getOctokit(token);

        info("Initializing AI model...");
        const openAI = new OpenAI({
            apiKey: modelToken,
        });

        if (github.context.payload.pull_request) {
            info("Fetching pull request details...");
            const pullRequestDiff = await getPullRequestDetails(octokit, {
                mode: "diff",
            });
            const pullRequestData = await getPullRequestDetails(octokit, {
                mode: "json",
            });

            if (getBooleanValue(deleteExistingReviews)) {
                info("Preparing to delete existing comments...");

                info("Fetching pull request reviews...");
                const reviews = await getAllReviewsForPullRequest(octokit);

                info(`Fetching reviews by bot...`);
                const reviewsByBot = reviews.data.filter(
                    r => r.user.login === "github-actions[bot]" || r.user.type === "Bot"
                ); // not possible to change the bot name - https://github.com/orgs/community/discussions/25853

                if (reviewsByBot.length > 0) {
                    info(`Found ${reviewsByBot.length} reviews by bot...`);
                    warning("Deleting existing comments for all reviews by bot...");

                    for (const review of reviewsByBot) {
                        const reviewComments = await getAllCommentsUnderAReview(octokit, review.id);

                        for (const comment of reviewComments.data) {
                            await deleteComment(octokit, comment.id);
                            await new Promise(resolve => setTimeout(resolve, 1500)); // Wait 1.5 seconds before deleting next comment to avoid rate limiting
                        }
                    }
                } else {
                    info("No reviews by bot found. Skipping deleting existing comments for all reviews by bot...");
                }
            } else {
                info("Skipping deleting existing comments for all reviews by bot...");
            }

            info(`Reviewing pull request ${pullRequestDiff.url}...`);
            const parsedDiff = parseDiff(pullRequestDiff.data);
            const rawComments = extractComments().raw(parsedDiff);

            info(`Generating suggestions using model ${getModelName(modelName)}...`);
            const suggestions = await getSuggestions(rawComments, openAI, rules, modelName, {
                body: pullRequestData.data.body,
            });

            if (suggestions.commentsToAdd.length === 0) {
                info("No suggestions found. Code review complete. All good!");
                return;
            }

            info("Adding review comments...");
            await addReviewComments(suggestions, octokit, rawComments);

            info("Code review complete!");
        } else {
            warning("Not a pull request, skipping...");
        }
    } catch (err) {
        error(err);
        core.setFailed(err.message);
    }
}

run();
