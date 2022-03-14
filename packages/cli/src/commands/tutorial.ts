import { TemplateService } from './../services/template.service';
import * as commander from 'commander';
import path from 'path';
import fs from 'fs-extra'
import Rx from 'rxjs'
import {
  getTutorialPaths,
  getTutorialContentByPath,
  getTutorialContentByPackageName,
} from '@builderdao/md-utils';
import inquirer, { Answers, DistinctQuestion } from 'inquirer';
import inquirerPrompt from 'inquirer-autocomplete-prompt';
import { binary_to_base58 } from 'base58-js'
import simpleGit, { CleanOptions } from 'simple-git';

import { log as _log, hashSumDigest } from '../utils';
import { BuilderDaoConfig } from '../services/builderdao-config.service';
import { getClient } from '../client';
import { format } from 'prettier';

inquirer.registerPrompt('autocomplete', inquirerPrompt);

export function makeTutorialCommand() {
  const rootNodeModulesFolderPath = path.join(
    __dirname,
    '../../../',
    'node_modules',
    '@builderdao-learn',
  );

  const tutorial = new commander.Command('tutorial').description('Tutorial');
  let client = getClient({
    kafePk: tutorial.optsWithGlobals().kafePk,
    network: tutorial.optsWithGlobals().network,
    payer: tutorial.optsWithGlobals().payer,
  })
  const log = (object: any) => _log(object, tutorial.optsWithGlobals().key);
  tutorial.command('list').action(async () => {
    const { allTutorials } = await getTutorialPaths(rootNodeModulesFolderPath);
    log(allTutorials.reduce((prev: any, curr) => {
      prev[curr.slug] = curr
      return prev
    }, {}));
  });

  tutorial
    .command('get')
    .argument('<learnPackageName>', 'Tutorial name')
    .action(async learnPackageName => {
      const tutorialMetadata = await getTutorialContentByPackageName({
        rootFolderPath: rootNodeModulesFolderPath,
        learnPackageName,
      });
      log(tutorialMetadata);
    });

  tutorial
    .command('prepublish')
    .argument('[learnPackageName]', 'Tutorial name')
    .action(async learnPackageName => {
      const rootFolder = learnPackageName
        ? path.join(rootNodeModulesFolderPath, learnPackageName)
        : process.cwd();
      const tutorialMetadata = await getTutorialContentByPath({
        rootFolder,
      });
      const { db } = new BuilderDaoConfig(rootFolder)
      await db.read()
      // const content = db.data?.content || {}
      // for (const file of tutorialMetadata.content) {
      await db.read()
      tutorialMetadata.content.forEach(async file => {
        const digest = await hashSumDigest(file.path);
        const relativePath = path.relative(rootFolder, file.path);
        db.chain
          .set(`content["${relativePath}"]`, {
            name: file.name,
            path: relativePath,
            digest
          }).value()
        await db.write();
      })
    });

  tutorial.command('init')
    .action(async () => {
      let emitter: Rx.Subscriber<DistinctQuestion<Answers>>;
      const observe = new Rx.Observable<DistinctQuestion<Answers>>((obs) => {
        emitter = obs;
        emitter.next({
          type: 'autocomplete',
          name: 'proposal_slug',
          message: "Project Slug",
          source: async (an: any, input: string) => {
            let proposals = []
            if (!input) {
              proposals = await client.getProposals()
            } else {
              proposals = await client.getProposals([
                {
                  memcmp: {
                    offset: 134,
                    bytes: binary_to_base58(Buffer.from(input)),
                  },
                },
              ])
            }
            return proposals.map(data => `${data.account.slug}`)
          }
        });
      });

      let proposalSlug: string;
      const getTutorialFolder = (slug: string) => path.join(path.join(__dirname, '../../../tutorials'), slug);
      let proposal: any;
      const git = simpleGit().clean(CleanOptions.FORCE)
      const ui = new inquirer.ui.BottomBar();
      inquirer.prompt(observe).ui.process.subscribe(async (q) => {
        if (q.name === 'proposal_slug') {
          proposalSlug = q.answer;
          proposal = await client.getTutorialBySlug(proposalSlug);
          log(proposal)
          emitter.next({
            type: "confirm",
            name: "proposal_confirm",
            message: `Are you sure you want to create a tutorial for ${q.answer}?`,
          });
          return;
        }

        if (q.name === 'proposal_confirm') {
          if (q.answer) {
            if (!(await git.status()).isClean()) {
              emitter.next({
                type: "confirm",
                name: "proposal_git_confirm",
                message: "You have uncommitted changes. Are you sure you want to continue?",
                default: false,
              });
            } else {
              ui.log.write('Git status is clean. Continuing...');
            }
            emitter.next({
              type: "confirm",
              name: "proposal_git_checkout_confirm",
              message: `Are you confirm to checkout the branch "tutorials/${proposalSlug}" ?`,
            })
          }
        }

        if (q.name === 'proposal_git_checkout_confirm') {
          if (q.answer === true) {
            await git.checkoutLocalBranch(`tutorials/${proposalSlug}`)
          } else {
            ui.log.write('Skipping checkout branch')
          }

          const tutorialExist = await fs.access(getTutorialFolder(proposalSlug))
            .then(() => true)
            .catch(() => false)

          if (tutorialExist) {
            ui.log.write('Tutorial folder already exists')
            emitter.complete();
          } else {
            emitter.next({
              type: "list",
              name: "tutorial_file_creation_confirm",
              message: `Select tutorial type "${getTutorialFolder(proposalSlug)}" ?`,
              choices: [
                {
                  name: "Single page Tutorial",
                  value: "simple",
                },
                {
                  name: "Multi page Tutorial",
                  value: "multipage"
                }
              ],
            })
          }
        }

        const template = new TemplateService(getTutorialFolder(proposalSlug));
        if (q.name === 'tutorial_file_creation_confirm') {
          await template.copy(q.answer);
          await template.setName(proposalSlug);
          const config = new BuilderDaoConfig(getTutorialFolder(proposalSlug))
          config.db.data ||= await config.initial({
            proposalId: proposal.id,
            slug: proposal.slug,
          })

          const formatReviewer = (data: any) => ({
            pda: data.pda,
            pubkey: data.pubkey,
            githubName: data.githubName,
          })
          const reviewer1 = await client.getReviewerByReviewerAccountPDA(proposal.reviewer1).then(formatReviewer)
          const reviewer2 = await client.getReviewerByReviewerAccountPDA(proposal.reviewer2).then(formatReviewer)

          config.db.chain.get('reviewers').push({reviewer1} as any, reviewer2 as any).value()

          await config.db.write();
          emitter.next({
            type: "input",
            name: "tutorial_title",
            message: "Tutorial title",
            default: proposalSlug,
          })
        }


        if (q.name === 'tutorial_title') {
          await template.setTitle(q.answer);
          const config = new BuilderDaoConfig(getTutorialFolder(proposalSlug))
          config.db.chain.set('title', q.answer).value();
          await config.db.write();
          emitter.next({
            type: "input",
            name: "tutorial_description",
            message: "Tutorial Description",
          })
        }

        if (q.name === 'tutorial_description') {
          await template.setDescription(q.answer);
          const config = new BuilderDaoConfig(getTutorialFolder(proposalSlug))
          config.db.chain.set('description', q.answer).value();
          await config.db.write();
          emitter.next({
            type: "input",
            name: "tutorial_tags",
            message: "Tags?  Commo seperated.",
          })
        }

        if (q.name === 'tutorial_tags') {
          await template.setDescription(q.answer);
          const config = new BuilderDaoConfig(getTutorialFolder(proposalSlug))
          config.db.chain.set('description', q.answer).value();
          await config.db.write();
          emitter.next({
            type: "confirm",
            name: "stage_changes",
            message: "Stage changes",
          })
        }

        if (q.name === 'stage_changes') {
          if (q.answer) {
            ui.log.write('Staging changes');
            await git.add('./*')
            console.log(await (await git.status()).staged)
            ui.log.write('Adding Commit');
            await git.commit(`🚀 ${proposalSlug} Tutorial Initial`);
            emitter.next({
              type: "confirm",
              name: "push_changes",
              message: "Push Changes",
            })
          }
        }

        if (q.name === 'push_changes') {
          if (q.answer) {
            await git.push(['-u', 'origin', `tutorials/${proposalSlug}`])
            ui.log.write(
              `🚀 ${proposalSlug} Tutorial Initialized`
            )
            emitter.complete()
          }
        }
      })
    })
  return tutorial;
}
