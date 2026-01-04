import { Devvit , TriggerContext, Context, UserNoteLabel } from "@devvit/public-api";
import {AppSettings, getAppSettings} from "./main.js";
import { getModPerms } from "./RedditUtils.js";
import { isBanned } from "./ModControl.js";

export interface ConfirmationResults {
  username: string;
  timeStarted?: Date;
  notified?: boolean;
  timeNotified?: Date;
  timeToOpenInSeconds?: number;
  notificationModmailId?: string;
  human?: boolean;
  bot?: boolean;
  chatgpt?: 'yes' | 'sometimes' |'no';
  usernameConfirm?: string;
  tokenDisplayed?: string;
  tokenEntered?: string;
  fakeTokenEntered? : string;
  understand?: boolean;
  timeCompleted?: Date;
  timeLapseSeconds?: number;
  verificationStatus?: 'verified' | 'pending' | 'timeout' | 'failed' | 'unverified';
  failureReasons?: string[];
  failureReportMarkdown?: string;
  failureReportPlain?: string;
  modOverridenStatus?: boolean;
  screenReader?: boolean;
}

export const confirmForm = Devvit.createForm(
  (data) => {
    const confirmationResults = parseConfirmationResultsWithDates(data.confirmationResults) as ConfirmationResults;
    return {
      fields: [
        {
            name: "human",
            label: "I am human",
            type: "boolean",
            defaultValue: false,
            required: true,
        },
        {
            name: "bot",
            label: "I am a bot",
            type: "boolean",
            defaultValue: false,
            required: true,
        },
        {
            name: "screenReader",
            label: "I rely on a screen reader",
            type: "boolean",
            defaultValue: false,
            required: true,
        },
        {
            name: "chatgpt",
            label: "Chat-GPT/AI?",
            helpText: "Do you use Chat-GPT or other AI tools to help you compose posts or comments?",
            type: "select",
            options: [
              { label: "Yes", value: "yes" },
              { label: "No", value: "no" },
              { label: "Sometimes", value: "sometimes" },
              { label: "Only For Language Translation", value: "tranlations" },
            ],
            defaultValue: [],
            editable: false,
            required: true,
        },
        {
            name: "usernameConfirm",
            label: "Username Confirmation",
            type: "select",
            helpText: "Select your username from the list",
            options: generateUsernameOptions(confirmationResults.username),
            defaultValue: [],
            editable: false,
            required: true,
        },
        {
            type: "group",
            name: "tokenChallengeGroup",
            label: "⚠️ Token Entry (Read Instructions Carefully)",
            fields: [
                {
                    name: "fakeTokenChallenge",
                    label: "Please enter this token: " + confirmationResults.tokenDisplayed,
                    type: "string",
                    defaultValue: "",
                    helpText: "Enter the token here, leave the next one blank!",
                },
                {
                    name: "realTokenChallenge",
                    label: "Please enter this token: " + confirmationResults.tokenDisplayed, 
                    type: "string",
                    defaultValue: "",
                    helpText: "Leave this token field blank!",
                }
            ]
        },
        {
          name: "understand",
          label: "⚠️ Failures may result in a ban",
          type: "select",
          options: [
            {label: 'I Don\'t Understand', value: 'no'},
            {label: 'I Understand', value: 'yes'}
          ],
          helpText: 'If you fail and/or are banned, you can reply in modmail for help',
          defaultValue: [],
          editable: false,
          required: true,
        }
      ],
      title: "Confirm Human",
      acceptLabel: "Confirm",
      cancelLabel: "Cancel",
    }
  },
  async ({ values }, context) => {
    console.log('Calculating results for u/' + context.username);
    let confirmationResults = await getConfirmationResults(context, context.username || '') as ConfirmationResults;
    confirmationResults.timeCompleted = new Date();
    if (confirmationResults.timeStarted) {
      confirmationResults.timeLapseSeconds =
        (confirmationResults.timeCompleted.getTime() -
        confirmationResults.timeStarted.getTime()) / 1000;
    } else {
      confirmationResults.timeLapseSeconds = undefined;
      // console.warn(
      //   `⚠️ Missing timeStarted for u/${confirmationResults.username}; cannot compute completion time`
      // );
    }
    confirmationResults.human = values.human;
    confirmationResults.bot = values.bot;
    confirmationResults.screenReader = values.screenReader;
    confirmationResults.chatgpt = Array.isArray(values.chatgpt) ? values.chatgpt[0] : values.chatgpt;

    const appSettings = await getAppSettings(context);
    if(Array.isArray(values.usernameConfirm)) {
      confirmationResults.usernameConfirm = values.usernameConfirm[0].replace('user_', '');
    } else {
      confirmationResults.usernameConfirm = values.usernameConfirm.replace('user_', '');
    }
    confirmationResults.tokenEntered = values.fakeTokenChallenge;
    confirmationResults.fakeTokenEntered = values.realTokenChallenge;
    confirmationResults.understand = values.understand[0] === 'yes';

    const {resultsBreakdown, modFailedOverride} = (await checkResults(context, confirmationResults, appSettings));
    const passed = confirmationResults.verificationStatus === 'verified';

    try {
      if(resultsBreakdown && confirmationResults.notificationModmailId) {
        if(confirmationResults.notificationModmailId) {
          await context.reddit.modMail.reply({
            body: resultsBreakdown,
            conversationId: confirmationResults.notificationModmailId,
            isInternal: true,
          });
        }
        await context.reddit.modMail.archiveConversation(confirmationResults.notificationModmailId);
      }
    }
    catch(error) {
      console.error('Failed to generate results breakdown and add to modmail conversation:', error);
    }

    let modNoteLabel = undefined;
    let modNote = undefined;

    if(passed && !modFailedOverride) {
      console.log('✅ u/' + confirmationResults.username + ' verification successul!');
      //context.ui.showToast({text: '✅ Human verification successful!', appearance: 'success'});
      modNote = '✅ Human Verification Successful';
    }
    else if(modFailedOverride) {
      console.log('❌ u/' + confirmationResults.username + ' verification failed, but is a mod, so ✅ successful');
      //context.ui.showToast({text: '❌ Human verification failed (but mod, so ✅ so successul)', appearance: 'success'});
      modNote = '❌ Human Verification Failed (But Mod, So ✅ Successful)';
    }
    else {
      console.log('❌ u/' + confirmationResults.username + ' verification failed');
      //context.ui.showToast({text: '❌ Human verification failed (reply to modmail for help)'});
      modNote = '❌ Human Verification Failed';
    }
    
    if(!passed && appSettings.banOnFailedVerification) {
      console.log(`User u/${confirmationResults.username} has failed verification. Banning user`);
      await context.reddit.banUser({
          username: confirmationResults.username,
          subredditName: context.subredditName || '',
          reason: 'Failed human verification, banned automatically',
          message: 'You have been banned for failing the human verification process. If you believe this is a mistake, please reply to this modmail.',
      });
      modNote += ' (User Banned)';
      modNoteLabel = 'BOT_BAN' as UserNoteLabel;
    }

    // ---- Add mod note (if needed) ----
    if(appSettings.trackVerificationInModNotes && modNote) {
      const { subredditName, postId, commentId } = context;
      const baseOptions: any = {
        subreddit: subredditName,
        user: confirmationResults.username,
        note: modNote,
      };
      const redditId = postId ?? commentId;
      if (redditId) {
        baseOptions.redditId = redditId;
      }
      if(modNoteLabel) {
        baseOptions.modNoteLabel = modNoteLabel;
      }
      try {
        await context.reddit.addModNote(baseOptions);
      }
      catch(error) {
        console.error('Failed to add verification mod note:', error);
      }
    }

    context.ui.showForm(confirmationDoneForm, {appSettings: JSON.stringify(appSettings), confirmationResults: JSON.stringify(confirmationResults), isBanned: await isBanned(context), modFailedOverride});
  }
);

export async function checkResults(
  context: Context,
  confirmationResults: ConfirmationResults,
  appSettings: AppSettings
): Promise<{
  resultsBreakdown: string;
  modFailedOverride: boolean;
}> {
  if (!confirmationResults) {
    return { resultsBreakdown: '', modFailedOverride: false };
  }

  let passed = true;
  const failureReasons: string[] = [];

  // Thresholds
  const minOpen = Number(appSettings.minHumanTimeToOpenConfirmForm ?? 0);
  const minConfirm = Number(appSettings.minHumanTimeToConfirmHuman ?? 0);

  // Time on form
 const timeLapseSeconds = confirmationResults.timeLapseSeconds;

  if (typeof timeLapseSeconds === 'number' && timeLapseSeconds < minConfirm) {
    passed = false;
    failureReasons.push(
      `Completed too quickly: ${timeLapseSeconds.toFixed(1)}s (min ${minConfirm}s)`
    );
  }

  // Time to open form
  if (confirmationResults.timeStarted && confirmationResults.timeNotified) {
    const openSeconds =
      (confirmationResults.timeStarted.getTime() -
        confirmationResults.timeNotified.getTime()) / 1000;

    if (openSeconds < minOpen) {
      passed = false;
      failureReasons.push(
        `Opened too quickly: ${openSeconds.toFixed(1)}s (min ${minOpen}s)`
      );
    }
  }

  // Human / bot checks
  if (!confirmationResults.human) {
    passed = false;
    failureReasons.push('Human Not Selected');
  }

  if (confirmationResults.bot) {
    passed = false;
    failureReasons.push('Bot Selected');
  }

  // AI usage & username checks (skip for screen readers)
  if (!confirmationResults.screenReader) {
    const aiUsage = confirmationResults.chatgpt;

    if (
      (appSettings.chatGPTUsageAllowed === 'some' && aiUsage === 'yes') ||
      (appSettings.chatGPTUsageAllowed === 'translations' &&
        (aiUsage === 'yes' || aiUsage === 'sometimes')) ||
      (appSettings.chatGPTUsageAllowed === 'nothing' && aiUsage !== 'no')
    ) {
      passed = false;
      failureReasons.push(`ChatGPT/AI Usage: "${aiUsage}"`);
    }

    if (
      !checkUsernameEntry(
        confirmationResults.username,
        confirmationResults.usernameConfirm || ''
      )
    ) {
      passed = false;
      failureReasons.push(
        `Actual Username:   "${confirmationResults.username}"`,
        `Username Selected: "${confirmationResults.usernameConfirm}"`
      );
    }
  }

  // Token check
  if (
    !checkTokenEntry(
      confirmationResults.tokenEntered,
      confirmationResults.tokenDisplayed
    )
  ) {
    passed = false;
    failureReasons.push(
      `Token Entered:   "${confirmationResults.tokenEntered}"`,
      `Token Displayed: "${confirmationResults.tokenDisplayed}"`
    );
  }

  // Fake token
  if (
    confirmationResults.fakeTokenEntered &&
    confirmationResults.fakeTokenEntered.trim() !== ''
  ) {
    passed = false;
    failureReasons.push(
      `Fake Token Entered: "${confirmationResults.fakeTokenEntered}"`
    );
  }

  // Understanding confirmation
  if (!confirmationResults.screenReader && !confirmationResults.understand) {
    passed = false;
    failureReasons.push('Understand Confirmation: No');
  }

  // Final verification status
  confirmationResults.verificationStatus = passed ? 'verified' : 'failed';
  confirmationResults.failureReasons = failureReasons;

  // Mod override
  let modFailedOverride = false;
  if (!passed && (await getModPerms(context)).length > 0) {
    confirmationResults.verificationStatus = 'verified';
    modFailedOverride = true;
  }

  // Build failure report (only if still failed)
  if (confirmationResults.verificationStatus === 'failed') {
    confirmationResults.failureReportMarkdown =
      renderFailureMarkdown(
        confirmationResults.username,
        failureReasons
      );

    confirmationResults.failureReportPlain =
      renderFailurePlain(confirmationResults.username, failureReasons);
  } else {
    confirmationResults.failureReportMarkdown = '';
    confirmationResults.failureReportPlain = '';
  }

  // Persist
  await setConfirmationResults(
    context,
    confirmationResults.username,
    confirmationResults
  );

  // Breakdown
  const resultsBreakdown =
    await generateConfirmationResultsBreakdown(
      confirmationResults,
      appSettings
    );

  return { resultsBreakdown, modFailedOverride };
}

function renderFailurePlain(username: string,reasons: string[]): string {
  return `❎ Failure Report for u/${username}\n\n` + reasons.join('\n');
}

function renderFailureMarkdown(
  username: string,
  reasons: string[]
): string {
  return [
    '---',
    `❎ Failure Report for u/${username}`,
    ...reasons.map(r => `• ${r}`),
    '\n---'
  ].join('  \n');
}

function checkUsernameEntry(username: string, usernameConfirm: string): boolean {
    //strip u/ if present
    if(usernameConfirm.startsWith('u/')) {
      usernameConfirm = usernameConfirm.substring(2);
    }
    return username === usernameConfirm;
}
function checkTokenEntry(tokenEntered: string | undefined, tokenExpected: string | undefined): boolean {
    //pass if tokens match, even if they are different cases or there's extra whitespace
    if(tokenEntered) tokenEntered = tokenEntered.toLowerCase().trim();
    if(tokenExpected) tokenExpected = tokenExpected.toLowerCase().trim();
    //also allow any order of characters, in case of dyslexia
    if(tokenEntered && tokenExpected) return tokenEntered.split('').sort().join('') === tokenExpected.split('').sort().join('');
    return tokenEntered === tokenExpected;
}

export const confirmationDoneForm = Devvit.createForm(
  (data) => {
    let confirmationResults = parseConfirmationResultsWithDates(data.confirmationResults) as ConfirmationResults;
    let appSettings = JSON.parse(data.appSettings);
    const modmailNeeded = confirmationResults.verificationStatus === 'failed' 
                        || (confirmationResults.verificationStatus === 'timeout' 
                            && appSettings.actionOnTimeoutVerification === 'remove')
                        || data.isBanned;
    const notificationModmailId = confirmationResults.notificationModmailId;
    const acceptLabel = modmailNeeded ? (notificationModmailId ? 'Need Mod Help' : 'Prepare Modmail') : 'Done';
    return {
      fields: [
        {
            name: "status",
            label: "Confirmation Status",
            type: "string",
            defaultValue: getUserVerificationStatus(confirmationResults, data.modFailedOverride as boolean),
            helpText: getUserVerificationHelpText(appSettings, confirmationResults, acceptLabel, data.isBanned, data.modFailedOverride),
            disabled: true,
        },
        //TODO allow retries in certain cases?
      ],
      title: "Human Confirmation Result",
      acceptLabel: acceptLabel,
      cancelLabel: "Close",
    }
  },
  async ({ values }, context) => {
    let confirmationResults = await getConfirmationResults(context, context.username || '') as ConfirmationResults;
    const appSettings = await getAppSettings(context);
    const modmailNeeded = confirmationResults.verificationStatus === 'failed' 
                        || (confirmationResults.verificationStatus === 'timeout' 
                            && appSettings.actionOnTimeoutVerification === 'remove');
    const notificationModmailId = confirmationResults.notificationModmailId;
    const needModHelp = modmailNeeded && notificationModmailId;
    const prepareModmail = modmailNeeded && !notificationModmailId;

    if(needModHelp) {
      await context.reddit.modMail.reply({
        body: 'Mod help requested. u/' + confirmationResults.username + ', please reply with details here',
        conversationId: notificationModmailId,
      });
    }
    else if(prepareModmail) {
      context.ui.navigateTo('https://www.reddit.com/message/compose?to=%2Fr%2F' + context.subredditName + '&subject=Human%20Verification%20failed');
    }
  }
);

function getUserVerificationStatus(confirmationResults: ConfirmationResults, modFailedOverride = false): string {
  let status = '';
  const verified = confirmationResults.verificationStatus === 'verified';
  const failed = confirmationResults.verificationStatus === 'failed';
  const timeout = confirmationResults.verificationStatus === 'timeout';
  if(verified) {
    status = `✅ u/${confirmationResults.username} Verified`;
  }
  else if(failed && modFailedOverride) {
    status = `❌ u/${confirmationResults.username} Verification Failed (but mod, so ✅ so successul)`;
      //context.ui.showToast({text: '❌ Human verification failed (but mod, so ✅ so successul)', appearance: 'success'});
  }
  else if(failed) {
    status = `❌ u/${confirmationResults.username} Verification Failed`;
  }
  else if(timeout) {
    status = `💤 u/${confirmationResults.username} Verification Timed Out`;
  }
  else { 
    //should never get here, but just in case
    status = `⚪️ u/${confirmationResults.username} Verification Unknown`;
  }
  return status;
}

function getUserVerificationHelpText(appSettings: AppSettings, confirmationResults: ConfirmationResults, acceptLabel: string, isBanned = false, modFailedOverride = false): string {
  let helpText = '';
  const verified = confirmationResults.verificationStatus === 'verified';
  const failed = confirmationResults.verificationStatus === 'failed';
  const timeout = confirmationResults.verificationStatus === 'timeout';
  if(verified || modFailedOverride) {
    if(!isBanned) {
      helpText = "You should not be blocked by posting/commenting (except from other potential rule filters)";
    }
    else {
      helpText = "You are still banned, so you will need to reach out in modmail for help.";
    }
  }
  else if(failed) {
    helpText = "You are " + (appSettings.actionOnPendingVerification !== 'remove' ? "" : "still ") + "blocked from posting/commenting. Please press '" + acceptLabel + "' if you believe this is a mistake.";
  }
  else if(timeout) {
    if(appSettings.actionOnTimeoutVerification !== 'remove') {
      helpText = "You are " + (appSettings.actionOnPendingVerification !== 'remove' ? "" : "still ") + "blocked from posting/commenting. Please press '" + acceptLabel + "' if you believe this is a mistake.";
    }
    else {
      helpText = "You should not be blocked by posting/commenting (except from other potential rule filters)";
    }
  }
  return helpText;
}

Devvit.addMenuItem({
  label: "Confirm Human",
  description:
    "Prevent potential blocks from posting and commenting",
  location: "subreddit",
  onPress: async (event, context) => {
    console.log(`\nMenu item 'Confirm Human' pressed by u/${context.username}:\n${JSON.stringify(event)}`);
    const username = (await context.reddit.getCurrentUser())?.username || '';
    if(!username) {
      console.log('Current username not found for verification.');
      context.ui.showToast('You need to be logged in to confirm');
      return;
    }

    const appSettings = await getAppSettings(context);
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    if(!appSettings.allowConfirmingWithoutNotification && (!confirmationResults || !confirmationResults.notified)) {
        console.log(`User u/${username} has not been notified for verification yet, and not allowed without mod request, so blocked`);
        context.ui.showToast('You must wait to be notified by a moderator request before you can confirm you are human');
        return;
    }
    if(confirmationResults.verificationStatus === 'verified' || confirmationResults.verificationStatus === 'failed' || confirmationResults.verificationStatus === 'timeout') {
      context.ui.showForm(confirmationDoneForm, {appSettings: JSON.stringify(appSettings), confirmationResults: JSON.stringify(confirmationResults)});
      return;
    }
    await startHumanConfirmationProcess(context, username, confirmationResults);
  }
});

async function startHumanConfirmationProcess(context: Context, username: string, confirmationResults: ConfirmationResults): Promise<void> {
  const appSettings = await getAppSettings(context);

  if(!confirmationResults) {  
    confirmationResults = {
      username: username,
      timeStarted: new Date(),
      tokenDisplayed: generateRandomToken(),
    };
    await setConfirmationResults(context, username, confirmationResults);
  }
  
  if(confirmationResults.verificationStatus === 'verified' || confirmationResults.verificationStatus === 'failed') {
    context.ui.showForm(confirmationDoneForm , {confirmationResults: JSON.stringify(confirmationResults)});
    return;
  }
  
  if(confirmationResults.verificationStatus === 'pending') {
    //reset start time and token
    confirmationResults.timeStarted = new Date();
    if(confirmationResults.timeNotified) confirmationResults.timeToOpenInSeconds = (confirmationResults.timeStarted.getTime() - confirmationResults.timeNotified.getTime()) / 1000;
    confirmationResults.timeCompleted = undefined;
    confirmationResults.timeLapseSeconds = undefined;
    confirmationResults.tokenDisplayed = generateRandomToken();
    confirmationResults.human = undefined;
    confirmationResults.bot = undefined;
    confirmationResults.screenReader = undefined;
    confirmationResults.chatgpt = undefined;
    confirmationResults.usernameConfirm = undefined;
    confirmationResults.tokenEntered = undefined;
    confirmationResults.fakeTokenEntered = undefined;
    confirmationResults.understand = undefined;
    confirmationResults.failureReasons = undefined;
    confirmationResults.failureReportPlain = undefined;
    confirmationResults.failureReportMarkdown = undefined;

    await setConfirmationResults(context, username, confirmationResults);
  }
  else {
    //check if timed out since notified
    const pendingTimeoutMinutes = appSettings.pendingConfirmationTimeoutMinutes;
    if(pendingTimeoutMinutes > 0 && 
        confirmationResults.timeNotified && 
        (new Date().getTime() - confirmationResults.timeNotified.getTime()) / 1000 > pendingTimeoutMinutes * 60) {
      confirmationResults.verificationStatus = 'timeout';
      await setConfirmationResults(context, username, confirmationResults);
      context.ui.showForm(confirmationDoneForm , {confirmationResults: JSON.stringify(confirmationResults)});
      return;
    }
    
    confirmationResults.tokenDisplayed = generateRandomToken();
    //otherwise set to pending to start verification
    //confirmationResults.verificationStatus = 'pending'; only set to pending on request or else they may timeout just by looking and cancelling
    if(!confirmationResults.timeStarted) {
      confirmationResults.timeStarted = new Date();
    }
    await setConfirmationResults(context, username, confirmationResults);
  }
  context.ui.showForm(confirmForm , {confirmationResults: JSON.stringify(confirmationResults)});

  // ---- Add mod note (if needed) ----
  if(appSettings.trackVerificationInModNotes) {
    const baseOptions: any = {
      subreddit: context.subredditName,
      user: confirmationResults.username,
      note: 'u/' + confirmationResults.username + ' has started human confirmation',
    };
    await context.reddit.addModNote(baseOptions);
  }
}

export async function getConfirmationResults(context: Context | TriggerContext , username: string): Promise<ConfirmationResults | boolean> {
  const resultsStr = await context.redis.get('ConfirmationResults:' + username);
  if (resultsStr) {
    return parseConfirmationResultsWithDates(resultsStr) as ConfirmationResults;
  }
  return false;
}
export async function setConfirmationResults(context: Context | TriggerContext , username: string, results: ConfirmationResults): Promise<void> {
  console.log('Setting u/' + username + '\'s confirmation results: ' + JSON.stringify(results));
  await context.redis.set('ConfirmationResults:' + username, JSON.stringify(results));
  await addResultUsername(context, username);
}
export async function deleteConfirmationResults(context: Context | TriggerContext, username: string): Promise<void> {
  console.log('Deleting u/' + username + '\'s confirmation results');
  await context.redis.del('ConfirmationResults:' + username);
  await removeResultUsername(context, username);
}

export async function getResultUsernames(context: Context | TriggerContext): Promise<Array<string>> {
  const resultsStr = await context.redis.get('ResultUsernames');
  if (resultsStr) {
    return JSON.parse(resultsStr) as Array<string>;
  }
  return [];
}
export async function addResultUsername(context: Context | TriggerContext , username: string): Promise<void> {
  const usernames = await getResultUsernames(context) as Array<string>;
  if(!usernames.includes(username)) {
    usernames.push(username);
  }
  await context.redis.set('ResultUsernames', JSON.stringify(usernames));
}
export async function removeResultUsername(context: Context | TriggerContext , username: string): Promise<void> {
  const usernames = await getResultUsernames(context) as Array<string>;
  const updated = usernames.filter(v => v !== username);
  await context.redis.set('ResultUsernames', JSON.stringify(updated));
}
export async function clearAllResults(context: Context | TriggerContext): Promise<void> {
  const usernames = await getResultUsernames(context) as Array<string>;
  console.log('⚠️ Clearing all ' + usernames.length + ' confirmation results');
  for(const username of usernames) {
    await deleteConfirmationResults(context, username);
  }
  await context.redis.del('ResultUsernames');
}

export async function generateConfirmationResultsBreakdown(
  confirmationResults: ConfirmationResults,
  appSettings: AppSettings
): Promise<string> {
  if (!confirmationResults) return '';

  const minOpen = Number(appSettings.minHumanTimeToOpenConfirmForm ?? 0);
  const minConfirm = Number(appSettings.minHumanTimeToConfirmHuman ?? 0);

  const {
    username,
    verificationStatus,
    timeToOpenInSeconds,
    screenReader,
    human,
    bot,
    chatgpt,
    usernameConfirm,
    tokenDisplayed,
    tokenEntered,
    fakeTokenEntered,
    understand,
    timeLapseSeconds,
    modOverridenStatus,
  } = confirmationResults;

  const lines: string[] = [];

  // Header
  if (verificationStatus === 'verified') {
    lines.push(`**✅ u/${username} passed human confirmation!**`);
  } else if (verificationStatus === 'failed') {
    lines.push(`❌ u/${username} failed human confirmation`);

    if (confirmationResults.failureReportMarkdown) {
      lines.push(
        '',
        confirmationResults.failureReportMarkdown
      );
    }
  }
  else {
    lines.push(`u/${username} human confirmation: ${verificationStatus}`);
  }
  lines.push('');

  // Details
  if (timeToOpenInSeconds) {
    lines.push(
      `* Time To Start After Notifying: ${timeToOpenInSeconds}s` +
      (minOpen > 0 ? ` (${minOpen}s min)` : '')
    );
  }

  lines.push(
    `* Selected Human: ${human}`,
    `* Selected Bot: ${bot}`,
    `* Selected Screen Reader: ${screenReader}${screenReader ? '*' : ''}`,
    `* Selected Use ChatGPT/Other: ${chatgpt}`,
    `* Selected Username: ${usernameConfirm}`,
    `* Token Displayed: ${tokenDisplayed ?? ''}`,
    `* Token Entered: ${tokenEntered ?? ''}`,
    `* Told To Leave Blank: ${fakeTokenEntered ?? ''}`,
    `* Confirmed Understanding: ${understand}`
  );

  if (typeof timeLapseSeconds === 'number') {
    lines.push(
      `* Time Taken On Form: ${timeLapseSeconds}s` +
      (minConfirm > 0 ? ` (${minConfirm}s min)` : '')
    );
  }

  if (modOverridenStatus) {
    lines.push(`* Mod Overriden: ${modOverridenStatus}`);
  }

  // Notes
  if (screenReader && !human) {
    lines.push(
      '',
      '*Screen reader used, so skipped checks with poor accessibility. If user has useful feedback for the form, please send modmail to r/MajorParadoxApps*'
    );
  }

  if (
    verificationStatus === 'verified' &&
    tokenDisplayed?.toLowerCase() !== tokenEntered?.toLowerCase()
  ) {
    lines.push(
      '',
      '*Token was considered a mismatch in case of dyslexia*'
    );
  }

  lines.push(
    '',
    verificationStatus === 'verified'
      ? '*Note: Passing verification does not guarantee they are human. They could be a very smart bot!*'
      : '*Failing verification does not guarantee they are a bot. They could have had trouble or messed up*'
  );

  if (confirmationResults.modOverridenStatus) {
    lines.push(
      '',
      '*User failed but is a mod, so counted as a success*'
    );
  }

  return lines.join('\n');
}

export function parseConfirmationResultsWithDates(resultsStr: string): ConfirmationResults {
  let confirmationResults = JSON.parse(resultsStr) as ConfirmationResults;

  if (confirmationResults?.timeNotified && typeof confirmationResults.timeNotified === 'string') {
    confirmationResults.timeNotified = new Date(confirmationResults.timeNotified);
  }
  if (confirmationResults?.timeStarted && typeof confirmationResults.timeStarted === 'string') {
    confirmationResults.timeStarted = new Date(confirmationResults.timeStarted);
  }
  if (confirmationResults?.timeCompleted && typeof confirmationResults.timeCompleted === 'string') {
    confirmationResults.timeCompleted = new Date(confirmationResults.timeCompleted);
  }

  return confirmationResults;
}

function generateUsernameOptions(username: string): {label: string, value: string}[] {
  const options = [];
  options.push({label: 'u/' + username, value: 'user_' + username});
  //generate 5 random fake usernames
  for(let i = 0; i < 5; i++) {
    const randomToken = generateRandomToken(username.length, username.length, false);
    options.push({label: 'u/' + randomToken, value: 'user_' + randomToken});
  }
  //shuffle the options
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  return options;
}

function generateRandomToken(min = 3, max = 5, skipOAnd0s = true): string {
  //generate random length between min and max
  const length = Math.floor(Math.random() * (max - min + 1)) + min;
  const characters = 'ABCDEFGHIJKLMN' + (skipOAnd0s ? '' : 'O') + 'PQRSTUVWXYZabcdefghijklmnopqrstuvwxyz123456789' + (skipOAnd0s ? '' : '0');
  let token = '';
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    token += characters.charAt(randomIndex);
  }
  return token;
}