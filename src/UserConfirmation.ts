import { Devvit , TriggerContext, Context, UserNoteLabel } from "@devvit/public-api";
import {AppSettings, getAppSettings} from "./main.js";

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
  modOverridenStatus?: boolean;
}

export const confirmForm = Devvit.createForm(
  (data) => {
    const confirmationResults = parseConfirmationResultsWithDates(data.confirmationResults) as ConfirmationResults;
    return {
      fields: [
        {
            name: "human",
            label: "I Am Human",
            type: "boolean",
            defaultValue: false,
            required: true,
        },
        {
            name: "bot",
            label: "I Am a Bot",
            type: "boolean",
            defaultValue: true,
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
            required: true,
        },
        {
            name: "usernameConfirm",
            label: "Username Confirmation",
            type: "select",
            helpText: "Select your username from the list",
            options: generateUsernameOptions(confirmationResults.username),
            defaultValue: [],
            required: true,
        },
        {
            type: "group",
            name: "tokenChallengeGroup",
            label: "Token Entry (⚠️ read instructions carefully)",
            fields: [
                {
                    name: "realTokenChallenge",
                    label: "Please enter this token: T-" + confirmationResults.tokenDisplayed + " (without the 'T-')", 
                    type: "string",
                    defaultValue: "",
                    helpText: "Leave this field blank!",
                },
                {
                    name: "fakeTokenChallenge",
                    label: "Please enter this token: T-" + confirmationResults.tokenDisplayed + " (without the 'T-')",
                    type: "string",
                    defaultValue: "",
                    helpText: "Enter the token here",
                },
            ]
        },
        {
          name: "understand",
          label: "⚠️ I understand that if I am found to be a bot, I may be banned.",
          type: "boolean",
          defaultValue: false,
          required: true,
        }
      ],
      title: "Confirm Human",
      acceptLabel: "Confirm",
      cancelLabel: "Cancel",
    }
  },
  async ({ values }, context) => {
    let confirmationResults = await getConfirmationResults(context, context.username || '') as ConfirmationResults;
    confirmationResults.timeCompleted = new Date();
    confirmationResults.timeLapseSeconds = (confirmationResults.timeCompleted.getTime() - (confirmationResults.timeStarted ? confirmationResults.timeStarted.getTime() : confirmationResults.timeCompleted.getTime())) / 1000;
    confirmationResults.human = values.human;
    confirmationResults.bot = values.bot;
    confirmationResults.chatgpt = Array.isArray(values.chatgpt) ? values.chatgpt[0] : values.chatgpt;

    const appSettings = await getAppSettings(context);
    if(Array.isArray(values.usernameConfirm)) {
      confirmationResults.usernameConfirm = values.usernameConfirm[0].replace('user_', '');
    } else {
      confirmationResults.usernameConfirm = values.usernameConfirm.replace('user_', '');
    }
    confirmationResults.tokenEntered = values.fakeTokenChallenge;
    confirmationResults.fakeTokenEntered = values.realTokenChallenge;
    confirmationResults.understand = values.understand;
    //determine if they passed
    let passed = true;
    let failureReport = '----- ❎ u/' + confirmationResults.username + ' Failure Report -----';
    let reportClose = '';
    for(let i = 0; i < failureReport.length; i++) {
        reportClose += '-';
    }
    failureReport += '\n';
    //let unsure = false;
    
    // Get thresholds from settings (ensure numbers)
    const minOpen = Number(appSettings.minHumanTimeToOpenConfirmForm ?? 0);
    const minConfirm = Number(appSettings.minHumanTimeToConfirmHuman ?? 0);

    // Example checks:
    if (confirmationResults.timeLapseSeconds < minConfirm) {
      passed = false;
      failureReport += `Completed too quickly: ${confirmationResults.timeLapseSeconds.toFixed(
        1
      )}s (min ${minConfirm}s)\n`;
    }

    // If you also track time from notification → form open, use a similar diff:
    if (confirmationResults.timeStarted && confirmationResults.timeNotified) {
      const openSeconds =
        (confirmationResults.timeStarted.getTime() -
          confirmationResults.timeNotified.getTime()) / 1000;

      if (openSeconds < minOpen) {
        passed = false;
        failureReport += `Opened too quickly: ${openSeconds.toFixed(
          1
        )}s (min ${minOpen}s)\n`;
      }
    }

    if(!confirmationResults.human || confirmationResults.bot) {
        passed = false;
        failureReport += (!confirmationResults.human ? "Human Not Selected\n" : "")
                      + (confirmationResults.bot ? "Bot Selected\n" : "");
    }

    if(appSettings.chatGPTUsageAllowed === 'some' && confirmationResults.chatgpt === 'yes') {
        passed = false;
        failureReport += "ChatGPT/AI Usage: \""+  confirmationResults.chatgpt + "\"\n";
    }
    else if(appSettings.chatGPTUsageAllowed === 'translations' && confirmationResults.chatgpt === 'yes' || confirmationResults.chatgpt === 'sometimes') {
        passed = false;
        failureReport += "ChatGPT/AI Usage: \""+  confirmationResults.chatgpt + "\"\n";
    }
    else if(appSettings.chatGPTUsageAllowed === 'nothing' && confirmationResults.chatgpt !== 'no') {
        passed = false;
        failureReport += "ChatGPT/AI Usage: \""+  confirmationResults.chatgpt + "\"\n";
    }
    if(!checkUsernameEntry(confirmationResults.username, confirmationResults.usernameConfirm || '')) {
        passed = false;
        failureReport += "Actual Username:   \""+  confirmationResults.username + "\"\n";
        failureReport += "Username Selected: \""+  confirmationResults.usernameConfirm + "\"\n";
    }
    if(!checkTokenEntry(confirmationResults.tokenEntered, confirmationResults.tokenDisplayed)) {
        passed = false;
        failureReport += "Token Entered:   \""+  confirmationResults.tokenEntered + "\"\n";
        failureReport += "Token Displayed: \""+  confirmationResults.tokenDisplayed + "\"\n";
    }
    if(confirmationResults.fakeTokenEntered && confirmationResults.fakeTokenEntered.trim() !== '') {
        passed = false;
        failureReport += "Fake Token Entered:\t\""+  confirmationResults.fakeTokenEntered + "\"\n";
    }
    if(!values.understand) {
        //unsure = true;
        //TODO should this be a failure?
        passed = false;
        failureReport += "Understand Confirmation Not Selected\n";
    }
    //if(unsure) {
        //TODO show advanced check form (to be implemented) - or something else?
        //return;
    //}

    confirmationResults.verificationStatus = passed ? 'verified' : 'failed';
    await setConfirmationResults(context, confirmationResults.username, confirmationResults);

    try {
      const breakdown = generateConfirmationResultsBreakdown(confirmationResults);
      if(breakdown && confirmationResults.notificationModmailId) {
        if(confirmationResults.notificationModmailId) {
          await context.reddit.modMail.reply({
            body: breakdown,
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

    if(passed) {
        console.log('✅ u/' + confirmationResults.username + ' verification successul!');
        context.ui.showToast({text: '✅ Human verification successful!', appearance: 'success'});
        modNote = 'u/' + confirmationResults.username + '✅ Human Verification Successfully';
    }
    else {
        console.log('❌ u/' + confirmationResults.username + ' verification failed');
        failureReport = '\n\n' + failureReport + reportClose + '\n\n';
        if(!passed) console.log(failureReport);
        //show toast for failure?
        modNote = 'u/' + confirmationResults.username + '❌ Human Verification Failed';
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
  }
);

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
    return tokenEntered === tokenExpected;
}

export const confirmationDoneForm = Devvit.createForm(
  (data) => {
    let confirmationResults = parseConfirmationResultsWithDates(data.confirmationResults) as ConfirmationResults;
    let appSettings = JSON.parse(data.appSettings);
    return {
      fields: [
        {
            name: "status",
            label: "Confirmation Status",
            type: "string",
            defaultValue: getUserVerificationStatus(confirmationResults),
            helpText: getUserVerificationHelpText(appSettings, confirmationResults),
            disabled: true,
        },
        //TODO allow retries in certain cases?
      ],
      title: "Human Confirmation Result",
      acceptLabel: "OK",
      cancelLabel: "Close",
    }
  },
  async ({ values }, context) => {
    //Do nothing, I guess?
  }
);

function getUserVerificationStatus(confirmationResults: ConfirmationResults): string {
  let status = '';
  const verified = confirmationResults.verificationStatus === 'verified';
  const failed = confirmationResults.verificationStatus === 'failed';
  const timeout = confirmationResults.verificationStatus === 'timeout';
  if(verified) {
    status = `u/${confirmationResults.username} Verified 🟢`;
  }
  else if(failed) {
    status = `u/${confirmationResults.username} Verification Failed 🔴`;
  }
  else if(timeout) {
    status = `u/${confirmationResults.username} Verification Timed Out 🟠`;
  }
  else { 
    //should never get here, but just in case
    status = `u/${confirmationResults.username} Verification Unknown ⚪️`;
  }
  return status;
}

function getUserVerificationHelpText(appSettings: AppSettings, confirmationResults: ConfirmationResults): string {
  let helpText = '';
  const verified = confirmationResults.verificationStatus === 'verified';
  const failed = confirmationResults.verificationStatus === 'failed';
  const timeout = confirmationResults.verificationStatus === 'timeout';
  if(verified) {
    helpText = "You should not be blocked by posting/commenting (except from other potential rule filters)";
  }
  else if(failed) {
    helpText = "You are " + (appSettings.actionOnPendingVerification !== 'remove' ? "" : "still ") + "blocked from posting/commenting. Please contact the moderators if you believe this is a mistake.";
  }
  else if(timeout) {
    if(appSettings.actionOnTimeoutVerification !== 'remove') {
      helpText = "You are " + (appSettings.actionOnPendingVerification !== 'remove' ? "" : "still ") + "blocked from posting/commenting. Please contact the moderators if you believe this is a mistake.";
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
    console.log(`Menu item 'Verify Human' pressed:\n${JSON.stringify(event)}`);
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
    if(confirmationResults.timeNotified) confirmationResults.timeToOpenInSeconds = confirmationResults.timeStarted.getTime() - confirmationResults.timeNotified.getTime() / 1000;
    confirmationResults.tokenDisplayed = generateRandomToken();
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

export function generateConfirmationResultsBreakdown(confirmationResults:ConfirmationResults):string {
  let breakdown = '';
  if(!confirmationResults) {
    return breakdown;
  }

  const {username, verificationStatus, notified, timeNotified, timeStarted, timeToOpenInSeconds,
        human, bot, chatgpt, usernameConfirm, tokenDisplayed, tokenEntered, 
        fakeTokenEntered, understand, timeCompleted, timeLapseSeconds, modOverridenStatus
  } = confirmationResults;

  if(verificationStatus === 'verified') {
    breakdown += '**✅ u/' + username + ' passed human confirmation!**';
  }
  else if(verificationStatus === 'failed') {
    breakdown += '❌ u/' + username + ' failed human confirmation';
  }
  else {
    //should we ever get here? Only creating this for a modmail
    breakdown += 'u/' + username + ' human confirmation: ' + verificationStatus;
  }
  breakdown += '\n\n';

  breakdown += timeToOpenInSeconds ? '* Time To Start After Notifying: ' + timeToOpenInSeconds + ' seconds\n' : '';
  breakdown += '* Selected Human: ' + human + '\n';
  breakdown += '* Selected Bot: ' + bot + '\n';
  breakdown += '* Selected Use ChatGPT/Other: ' + chatgpt + '\n';
  breakdown += '* Selected Username: ' + usernameConfirm + '\n';
  breakdown += '* Token Displayed: ' + (tokenDisplayed ? tokenDisplayed : '') + '\n';
  breakdown += '* Token Entered:   ' + (tokenEntered ? tokenEntered : '') + '\n';
  breakdown += '* Told To Leave Blank:   ' + (fakeTokenEntered ? fakeTokenEntered : '') + '\n';
  breakdown += '* Confirmed Understanding:   ' + understand + '\n';
  breakdown += timeLapseSeconds ? '* Time Taken On Form: ' + timeLapseSeconds + ' seconds\n' : '';
  breakdown += modOverridenStatus ? '* Mod Overriden: ' + modOverridenStatus + '\n' : '';

  breakdown += '\n*Note: Passing verification does not guarantee they are human*';

  return breakdown;
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