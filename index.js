import core from "@actions/core";
import github from "@actions/github";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { ChatMistralAI, ChatMistralAICallOptions } from "@langchain/mistralai";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { AIMessage } from "@langchain/core/messages";
import parseDiff from "parse-diff";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import mm from "micromatch";

import { aDiff, diffPayloadSchema, diffPayloadSchemaWithRequiredSuggestions } from "./utils/types.js";
import { DEFAULT_MODEL, COMMON_SYSTEM_PROMPT, FILES_IGNORED_BY_DEFAULT, BASE_URL } from "./utils/constants.js";

/**
 * @typedef {import("@actions/github/lib/utils").GitHub} GitHub
 * @typedef {z.infer<typeof aDiff>[]} rawCommentsPayload
 * @typedef {z.infer<typeof diffPayloadSchema>} suggestionsPayload
 * @typedef {{ path: string, line: number, body: string }[]} CommentsPayload
 * @typedef {InstanceType<GitHub>} OctokitApi
 * @typedef {parseDiff.File[]} ParsedDiff
 * @typedef {{ body: string | null }} PullRequestContext
 * @typedef {'openai' | 'anthropic' | 'mistral' | 'openrouter' | 'google'} AIPlatform
 * @typedef {OpenAI | Anthropic | ChatMistralAI<ChatMistralAICallOptions>} AIPlatformSDK
 * @typedef {{
 *  info: (message: string) => void,
 *  warning: (message: string) => void,
 *  error: (error: string) => void
 * }} Logger
 */

/**
 * @param {string} name
 * @param {AIPlatform} platform
 * @returns {string}
 */
function getModelName(name, platform) {
    return name !== "" ? name : DEFAULT_MODEL[`${platform.toUpperCase()}`].name;
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
     * @param {rawCommentsPayload} rawComments
     * @param {string[]} filesToIgnore
     * @returns {rawCommentsPayload}
     */
    const filteredRawComments = (rawComments, filesToIgnore) =>
        rawComments.filter(comment => {
            return !mm.isMatch(comment.path, filesToIgnore, { dot: true });
        });

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
        filteredRaw: filteredRawComments,
        comments: commentsWithSuggestions,
    };
}

/**
 * @param {string} rules
 * @param {rawCommentsPayload} rawComments
 * @param {PullRequestContext} pullRequestContext
 * @returns {string}
 */
function getUserPrompt(rules, rawComments, pullRequestContext) {
    return `I want you to code review a pull request ${rules ? ` by including the following rules: ${rules} \nThe rules provided describe how the code should be` : ""}. Here's the diff payload from the pull request:
            ${JSON.stringify(rawComments)}
            ${pullRequestContext.body ? `\nAlso, here's the pull request description on what it's trying to do to give you some more context (keep in mind that the description is not always accurate and can be incorrect, so compare the code changes in the diff to the description): ${pullRequestContext.body})` : ""}.`;
}

/**
 * @param {{
 *  rawComments: rawCommentsPayload,
 *  openAI: OpenAI,
 *  rules: string,
 *  modelName: string,
 *  pullRequestContext: PullRequestContext,
 *  platform: AIPlatform
 * }} params
 * @returns {Promise<suggestionsPayload | null>}
 */
async function useOpenAI({ rawComments, openAI, rules, modelName, pullRequestContext, platform }) {
    const modelDeepseek = /deepseek/i.test(getModelName(modelName, platform));
    const result = !modelDeepseek
        ? await openAI.beta.chat.completions.parse({
              model: getModelName(modelName, platform),
              messages: [
                  {
                      role: "system",
                      content: COMMON_SYSTEM_PROMPT,
                  },
                  {
                      role: "user",
                      content: getUserPrompt(rules, rawComments, pullRequestContext),
                  },
              ],
              response_format: zodResponseFormat(diffPayloadSchema, "json_diff_response"),
          })
        : await openAI.chat.completions.create({
              model: getModelName(modelName, platform),
              messages: [
                  {
                      role: "system",
                      content: COMMON_SYSTEM_PROMPT,
                  },
                  {
                      role: "user",
                      content: `${getUserPrompt(rules, rawComments, pullRequestContext)} - IMP: give the output in a valid JSON string (it should be not be wrapped in markdown, just plain json object) and stick to the schema mentioned here: 
                      {
                        commentsToAdd: {
                            path: string;
                            position: number;
                            line: number;
                            change: {
                                type: string;
                                add: boolean;
                                ln: number;
                                content: string;
                                relativePosition: number;
                            };
                            previously?: string | undefined;
                            suggestions?: string | undefined;
                        }[];
                      }.`,
                  },
              ],
              response_format: {
                  type: "json_object",
              },
          });

    const { message } = result.choices[0];

    if (message.refusal) {
        throw new Error(`the model refused to generate suggestions - ${message.refusal}`);
    }

    return modelDeepseek ? JSON.parse(message.content) : message.parsed;
}

/**
 * @param {{
 *  rawComments: rawCommentsPayload,
 *  anthropic: Anthropic,
 *  rules: string,
 *  modelName: string,
 *  pullRequestContext: PullRequestContext
 * }} params
 * @returns {Promise<suggestionsPayload | null>}
 */
async function useAnthropic({ rawComments, anthropic, rules, modelName, pullRequestContext }) {
    const { definitions } = zodToJsonSchema(diffPayloadSchema, "diffPayloadSchema");
    const result = await anthropic.messages.create({
        max_tokens: 8192,
        model: getModelName(modelName, "anthropic"),
        system: COMMON_SYSTEM_PROMPT,
        tools: [
            {
                name: "structuredOutput",
                description: "Structured Output",
                input_schema: definitions["diffPayloadSchema"],
            },
        ],
        tool_choice: {
            type: "tool",
            name: "structuredOutput",
        },
        messages: [
            {
                role: "user",
                content: getUserPrompt(rules, rawComments, pullRequestContext),
            },
        ],
    });

    let parsed = null;
    for (const block of result.content) {
        if (block.type === "tool_use") {
            parsed = block.input;
            break;
        }
    }

    return parsed;
}

/**
 * @param {{
 *  rawComments: rawCommentsPayload,
 *  mistral: ChatMistralAI<ChatMistralAICallOptions>,
 *  rules: string,
 *  modelName: string,
 *  pullRequestContext: PullRequestContext
 * }} params
 * @returns {Promise<suggestionsPayload | null>}
 */
async function useMistral({ rawComments, mistral, rules, modelName, pullRequestContext }) {
    mistral.model = getModelName(modelName, "mistral");
    mistral.safePrompt = true;

    const parser = StructuredOutputParser.fromZodSchema(diffPayloadSchemaWithRequiredSuggestions);

    const result = await mistral
        .withStructuredOutput(diffPayloadSchemaWithRequiredSuggestions, {
            name: "diffPayloadSchemaWithRequiredSuggestions",
            method: "json_mode",
        })
        .invoke([
            ["system", COMMON_SYSTEM_PROMPT],
            [
                "user",
                `${getUserPrompt(rules, rawComments, pullRequestContext)}\n${parser.getFormatInstructions()}\nDon't give partial response. Sometimes the json is cut off in between. Please provide the full json response.`,
            ],
        ]);

    if (!result || result.commentsToAdd.length === 0) {
        throw new Error(`the model refused to generate suggestions - ${result}`);
    }

    await parser.invoke(new AIMessage(JSON.stringify(result))); // validate output with schema
    return result;
}

/**
 * Retries an async function with exponential backoff
 * @template T
 * @param {() => Promise<T>} fn The async function to retry
 * @param {{
 *  retries?: number,
 *  initialDelay?: number,
 *  maxDelay?: number,
 *  backoffFactor?: number,
 *  retryableErrors?: string[],
 *  onRetry?: (info: {
 *    error: Error,
 *    attempt: number,
 *    remainingAttempts: number,
 *    delay: number
 *  }) => void,
 * }} options Configuration options
 * @returns {Promise<T>}
 */
async function retry(
    fn,
    {
        retries = 3,
        initialDelay = 1500, // Start with 1.5 seconds
        backoffFactor = 2, // Double the delay each time
        maxDelay = 10000, // Never wait more than 10 seconds
        nonRetryableErrors = ["Unsupported AI platform", "Too many tokens"],
        onRetry = null,
    } = {}
) {
    let lastError;
    let delay = initialDelay;

    if (retries === 0) {
        return await fn();
    }

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            const shouldNotRetry = nonRetryableErrors.some(errMsg =>
                error.message.toLowerCase().includes(errMsg.toLowerCase())
            );

            if (shouldNotRetry || attempt === retries - 1) {
                throw error;
            }

            if (onRetry) {
                onRetry({
                    error,
                    attempt: attempt + 1,
                    remainingAttempts: retries - attempt - 1,
                    delay,
                });
            }

            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * backoffFactor, maxDelay);
        }
    }

    throw lastError;
}

/**
 * @param {{
 *  platform: AIPlatform,
 *  rawComments: rawCommentsPayload,
 *  platformSDK: AIPlatformSDK,
 *  rules: string,
 *  modelName: string,
 *  pullRequestContext: PullRequestContext,
 *  maxRetries: number
 * }} params
 * @returns {Promise<suggestionsPayload | null>}
 */
async function getSuggestions({
    platform,
    rawComments,
    platformSDK,
    rules,
    modelName,
    pullRequestContext,
    maxRetries,
}) {
    const { error, warning } = log({ withTimestamp: true }); // eslint-disable-line no-use-before-define

    try {
        return await retry(
            async () => {
                if (platform === "openai" || platform === "google" || platform === "openrouter") {
                    return await useOpenAI({
                        rawComments,
                        openAI: platformSDK,
                        rules,
                        modelName,
                        pullRequestContext,
                        platform,
                    });
                }

                if (platform === "anthropic") {
                    return await useAnthropic({
                        rawComments,
                        anthropic: platformSDK,
                        rules,
                        modelName,
                        pullRequestContext,
                    });
                }

                if (platform === "mistral") {
                    return await useMistral({
                        rawComments,
                        mistral: platformSDK,
                        rules,
                        modelName,
                        pullRequestContext,
                    });
                }

                throw new Error(`Unsupported AI platform: ${platform}`);
            },
            {
                retries: maxRetries ?? 3,
                onRetry: ({ error: retryError, attempt, remainingAttempts, delay }) => {
                    error(`Attempt ${attempt} failed: ${retryError.message}.`);
                    warning(`Retrying in ${delay}ms. Remaining attempts: ${remainingAttempts}.`);
                },
            }
        );
    } catch (err) {
        error(`Could not generate suggestions: ${err.message}`);
        core.setFailed(`Could not generate suggestions: ${err.message}`);
        return null;
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
 * @param {string} modelName
 */
async function addReviewComments(suggestions, octokit, rawComments, modelName) {
    const { info } = log({ withTimestamp: true }); // eslint-disable-line no-use-before-define
    const comments = filterPositionsNotPresentInRawPayload(rawComments, extractComments().comments(suggestions));

    try {
        await octokit.rest.pulls.createReview({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            pull_number: github.context.payload.pull_request.number,
            body: `Code Review by ${modelName}`,
            event: "COMMENT",
            comments,
        });
    } catch (error) {
        info(`Failed to add review comments: ${JSON.stringify(comments, null, 2)}`);
        throw error;
    }
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

/**
 * Returns an instance of the AI platform SDK given the platform name and API key.
 *
 * @param {AIPlatform} platform - The name of the AI platform.
 * @param {string} apiKey - The API key for the AI platform.
 * @returns {AIPlatformSDK | Error} The AI platform SDK instance.
 */
function getPlatformSDK(platform, apiKey) {
    if (platform === "openai") return new OpenAI({ apiKey });
    if (platform === "anthropic") return new Anthropic({ apiKey });
    if (platform === "mistral") return new ChatMistralAI({ apiKey });
    if (platform === "openrouter") return new OpenAI({ apiKey, baseURL: BASE_URL.OPENROUTER });
    if (platform === "google") return new OpenAI({ apiKey, baseURL: BASE_URL.GOOGLE });

    throw new Error(`Unsupported AI platform: ${platform}`);
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
        const platform = core.getInput("platform");
        const filesToIgnore = core.getInput("filesToIgnore");
        const maxRetries = core.getInput("max-retries");
        const octokit = github.getOctokit(token);

        info("Initializing AI model...");
        const platformSDK = getPlatformSDK(platform, modelToken);

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

            info("Getting files to ignore...");
            const filesToIgnoreList = [
                ...new Set(
                    filesToIgnore
                        .split(";")
                        .map(file => file.trim())
                        .filter(file => file !== "")
                        .concat(FILES_IGNORED_BY_DEFAULT)
                ),
            ];

            const filteredRawComments = extractComments().filteredRaw(rawComments, filesToIgnoreList);

            info(`Generating suggestions using model ${getModelName(modelName, platform)}...`);
            const suggestions = await getSuggestions({
                platform,
                rawComments: filteredRawComments,
                platformSDK,
                rules,
                modelName,
                maxRetries: Number(maxRetries),
                pullRequestContext: {
                    body: pullRequestData.data.body,
                },
            });

            if (!suggestions) {
                warning("Could not generate suggestions. Refer to the error log for more information and try again.");
                return;
            }

            if (suggestions.commentsToAdd.length === 0) {
                info("No suggestions found. Code review complete. All good!");
                return;
            }

            info("Adding review comments...");
            await addReviewComments(suggestions, octokit, filteredRawComments, getModelName(modelName, platform));

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
