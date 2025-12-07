import { Devvit , TriggerContext, Context } from "@devvit/public-api";
import { ConfirmationResults, getConfirmationResults, setConfirmationResults } from "./UserConfirmation.js";
import { AppSettings, getAppSettings } from "./main.js";

// Handling a PostSubmit event
Devvit.addTrigger({
  event: 'PostSubmit',
  onEvent: async (event, context) => {
    const username = event.author?.name;
    if(!username) {
      console.log('No username found in PostSubmit event.');
      return;
    }
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    if(!confirmationResults) {
      return;
    }

    const appSettings = await getAppSettings(context);
    await handlePostOrComment(true, event.post?.id || '', context, username, confirmationResults, appSettings);
  }
});

//Handling a CommentSubmit event
Devvit.addTrigger({
  event: 'CommentSubmit',
  onEvent: async (event, context) => {
    const username = event.author?.name;
    if(!username) {
      console.log('No username found in PostSubmit event.');
      return;
    }
    let confirmationResults = await getConfirmationResults(context, username) as ConfirmationResults;
    if(!confirmationResults) {
      return;
    }

    const appSettings = await getAppSettings(context);
    await handlePostOrComment(false, event.comment?.id || '', context, username, confirmationResults, appSettings);
  }
});

async function handlePostOrComment(isPost: boolean, contentId: string, context: TriggerContext, username: string, confirmationResults: ConfirmationResults, appSettings: AppSettings): Promise<void> {
    const subredditName = context.subredditName || '';
    let action = '';
    let reason = '';
    let modmailRemovalSubject = '';
    let modmailRemovalMessage = '';

    const contentString = isPost ? 'Post' : 'Comment';
    const commentId = isPost ? '' : contentId.split("_")[1];
    const postId = isPost ? contentId.split("_")[1] : (await context.reddit.getCommentById(contentId)).postId.split('_')[1];

    const contentURL = isPost
        ? `https://www.reddit.com/r/${subredditName}/comments/${postId}`
        : `https://www.reddit.com/r/${subredditName}/comments/${postId}/comment/${commentId}?context=3`;
    const kindLink = `[${contentString.toLowerCase()}](${contentURL})`

    if(confirmationResults.verificationStatus === 'failed') {
        console.log(`User u/${username} has failed verification. Taking appropriate action on ${contentString.toLocaleLowerCase()} submission.`); 
        action = appSettings.spamFailedVerification ? 'spam' : 'remove';
        reason = 'Human verification failed';
        modmailRemovalSubject = 'Notification: ' + contentString + ' Removed Due to Failed Human Verification';
        modmailRemovalMessage = `Your recent ${kindLink} in r/${subredditName} has been removed because you failed the required human verification process. Please contact the moderation team if you believe this is a mistake.`;
    }
    else if(confirmationResults.verificationStatus === 'timeout') {
        console.log(`User u/${username} has timed out verification. Taking appropriate action on ${contentString.toLocaleLowerCase()} submission.`); 
        action = appSettings.actionOnTimeoutVerification;
        reason = 'Human verification timed out' + action === 'report' ? ', please review' : '';
        modmailRemovalSubject = 'Notification: ' + contentString + ' Removed Due to Timed Out Human Verification';
        modmailRemovalMessage = `Your recent ${kindLink} in r/${subredditName} has been removed because you did not complete the required human verification process in time. Please contact the moderation team if you believe this is a mistake.`;
    }
    else if(confirmationResults.verificationStatus === 'pending') {
        console.log(`User u/${username} has pending verification. Taking appropriate action on post submission.`); 
        action = appSettings.actionOnPendingVerification;
        reason = 'Human verification pending' + action === 'report' ? ', please review' : '';
        modmailRemovalSubject = 'Notification: ' + contentString + ' Removed Due to Pending Human Verification';
        modmailRemovalMessage = `Your recent ${kindLink} in r/${subredditName} has been removed because your human verification process is still pending. Please complete the verification to avoid further actions on your posts.`; 
    }

    if(action === 'remove' || action === 'spam' || action === 'report') {
      const content = isPost ? await context.reddit.getPostById(contentId || '') : await context.reddit.getCommentById(contentId || '');
      if(!content) {
        console.log(isPost ? 'No post data in PostSubmit event.' : 'No comment data in CommentSubmit event.');
        return;
      }
      if(action === 'remove' || action === 'spam') {
        await context.reddit.remove(contentId, action === 'spam');

        //get or create a custom removal reason for logging
        try {
          const reasonId = await getOrCreateCustomReasonId(context.reddit, subredditName);
          await content.addRemovalNote({
            reasonId: reasonId,
            modNote: reason,
          });
        }
        catch(error) {
          console.log('Failed to add mod note', error);
        }

        if(appSettings.notifyUserPostAndCommentRemovals) {
          let conversationId = '';
          const notificationModmailId = confirmationResults.notificationModmailId;
          if(notificationModmailId) {
            await context.reddit.modMail.reply({
              body: modmailRemovalMessage,
              conversationId: notificationModmailId,
            });
            conversationId = notificationModmailId;
          }
          else {
            const modmail = await context.reddit.modMail.createConversation({
                subredditName: context.subredditName || '',
                subject: modmailRemovalSubject,
                body: modmailRemovalMessage,
                to: username,
            });
            conversationId = modmail.conversation.id || '';
            confirmationResults.notificationModmailId = conversationId;
            await setConfirmationResults(context, confirmationResults.username, confirmationResults);
          }
          await context.reddit.modMail.archiveConversation(conversationId);
        }
      }
      else if(action === 'report') { 
        console.log(`Reporting u/${username}'s ${contentString.toLocaleLowerCase()} for human verification status: ${confirmationResults.verificationStatus}.`); 
        await context.reddit.report(content, {reason: reason});
      }

      if(confirmationResults.verificationStatus === 'timeout' && appSettings.banOnConfirmationTimeout) {
            console.log(`User u/${username} has timed out verification. Banning user on post submission.`);
            await context.reddit.banUser({
              username: content.authorId || '',
              subredditName: subredditName || '',
              reason: 'Failure to complete human verification in time, banned automatically',
              context: contentId,
              message: 'You have been banned for failing to complete the human verification process in time. If you believe this is a mistake, please reply to this modmail.',
            });
            return;
        }
    }
}

async function getOrCreateCustomReasonId(
  reddit: Devvit.Context['reddit'],
  subredditName: string
): Promise<string> {
  const reasons = await reddit.getSubredditRemovalReasons(subredditName);

  const existing = reasons.find((r) => r.title === 'Custom Reason');
  if (existing) return existing.id;

  const newId = await reddit.addSubredditRemovalReason(subredditName, {
    title: 'Custom Reason',
    message: '',
  });

  return newId;
}