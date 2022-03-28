#!/usr/bin/env node

import {
  gitlabGetDiscussions,
  gitlabUpdateNote,
  BlackduckApiService,
  findOrDownloadDetect,
  IRapidScanResults,
  createRapidScanReportString
} from "@jcroall/synopsys-sig-node/lib/"

import {logger} from "@jcroall/synopsys-sig-node/lib";
import * as fs from "fs";
import * as os from "os";
import path from "path";
import {runDetect} from "@jcroall/synopsys-sig-node/lib/blackduck/detect/detect-manager";
import {POLICY_SEVERITY, SUCCESS} from "@jcroall/synopsys-sig-node/lib/blackduck/detect/exit-codes";
import {gitlabCreateDiscussionWithoutPosition} from "@jcroall/synopsys-sig-node/lib/gitlab/discussions";

const chalk = require('chalk')
const figlet = require('figlet')
const program = require('commander')

const COMMENT_PREFACE = '<!-- Comment automatically managed by Detect Integration, do not remove this line -->'

export async function main(): Promise<void> {
  console.log(
      chalk.blue(
          figlet.textSync('detect-gitlab', { horizontalLayout: 'full' })
      )
  )
  program
      .description("Integrate Synopsys Black Duck Software Composition Analysis into GitLab")
      .requiredOption('-u, --url <Black Duck URL>', 'Location of the Black Duck Hub server')
      .requiredOption('-t, --token <Black Duck API Token>', 'Black Duck API Token')
      .option('-v, --detect-version <Version number>', 'Version of Detect to use')
      .option('-m, --scan-mode <RAPID|INTELLIGENT>', 'Black Duck scan mode')
      .option('-f, --fail-on-all', 'Fail on all policy severities')
      .option('-s, --detect-trust-cert', 'Explicitly trust Black Duck Hub SSL Cert')
      .option('-d, --debug', 'Enable debug mode (extra verbosity)')
      .parse(process.argv)

  const options = program.opts()

  logger.info(`Starting Black Duck GitLab Integration`)

  const BLACKDUCK_URL = options.url
  const BLACKDUCK_API_TOKEN = options.token
  const SCAN_MODE = options.scanMode ? options.scanMode : "RAPID"
  const FAIL_ON_ALL = options.failOnAll ? options.failOnAll : false
  const DETECT_TRUST_CERT = options.detectTrustCert ? options.detectTrustCert : false

  if (SCAN_MODE != "RAPID" && SCAN_MODE != "INTELLIGENT") {
    logger.error(`Scan mode must be RAPID or INTELLIGENT`)
    process.exit(1)
  }

  const GITLAB_TOKEN = process.env['GITLAB_TOKEN']
  const CI_SERVER_URL = process.env['CI_SERVER_URL']
  const CI_MERGE_REQUEST_IID = process.env['CI_MERGE_REQUEST_IID']! // MR Only
  const CI_MERGE_REQUEST_DIFF_BASE_SHA = process.env['CI_MERGE_REQUEST_DIFF_BASE_SHA'] // MR Only
  const CI_COMMIT_SHA = process.env['CI_COMMIT_SHA']
  const CI_PROJECT_NAMESPACE = process.env['CI_PROJECT_NAMESPACE']
  const CI_PROJECT_NAME = process.env['CI_PROJECT_NAME']
  const CI_PROJECT_ID = process.env['CI_PROJECT_ID']
  const CI_COMMIT_BRANCH = process.env['CI_COMMIT_BRANCH'] // Push only

  if (!GITLAB_TOKEN || !CI_SERVER_URL || !CI_PROJECT_NAMESPACE || !CI_PROJECT_NAME || !CI_PROJECT_ID || !CI_COMMIT_SHA) {
    logger.error(`Must specify GITLAB_TOKEN, CI_SERVER_URL, CI_PROJECT_NAMESPACE, CI_PROJECT_ID, CI_COMMIT_SHA and CI_PROJECT_NAME.`)
    process.exit(1)
  }

  let is_merge_request = !!CI_MERGE_REQUEST_IID

  if (!is_merge_request) {
    if (!CI_COMMIT_BRANCH) {
      logger.error(`Must specify CI_COMMIT_BRANCH.`)
      process.exit(1)
    }
  } else {
    if (!CI_MERGE_REQUEST_DIFF_BASE_SHA) {
      logger.error(`Must specify CI_MERGE_REQUEST_DIFF_BASE_SHA when running from merge request.`)
      process.exit(1)
    }
  }

  const runnerTemp = os.tmpdir()
  const outputPath = path.resolve(runnerTemp, 'blackduck')

  if (SCAN_MODE === 'RAPID') {
    logger.info('Checking that you have at least one enabled policy...')

    const blackduckApiService = new BlackduckApiService(BLACKDUCK_URL, BLACKDUCK_API_TOKEN)
    const blackDuckBearerToken = await blackduckApiService.getBearerToken()
    let policiesExist: boolean | void = await blackduckApiService.checkIfEnabledBlackduckPoliciesExist(blackDuckBearerToken).catch(reason => {
      logger.error(`Could not verify whether policies existed: ${reason}`)
    })

    if (policiesExist === undefined) {
      logger.error('Could not determine if policies existed. Eixting.')
      process.exit(1)
    } else if (!policiesExist) {
      logger.error(`Could not run using ${SCAN_MODE} scan mode. No enabled policies found on the specified Black Duck server.`)
      process.exit(1)
    } else {
      logger.info(`You have at least one enabled policy, executing in ${SCAN_MODE} scan mode...`)
    }
  }

  const detectPath = await findOrDownloadDetect(runnerTemp).catch(reason => {
    logger.error(`Unable to download Detect: ${reason}`)
    process.exit(1)
  })

  const detectArgs = [`--blackduck.url=${BLACKDUCK_URL}`,
    `--blackduck.api.token=${BLACKDUCK_API_TOKEN}`,
    `--detect.blackduck.scan.mode=${SCAN_MODE}`,
    `--detect.output.path=${outputPath}`,
    `--detect.scan.output.path=${outputPath}`]

  if (DETECT_TRUST_CERT) {
    detectArgs.push('--blackduck.trust.cert=TRUE')
  }

  logger.info(`Executing: ${detectPath} ${detectArgs}`)

  if (detectPath === undefined) {
    logger.debug(`Could not determine detect path. Canceling policy check.`)
    process.exit(1)
  }

  const detectExitCode = await runDetect(detectPath, detectArgs).catch(reason => {
    logger.error(`Could not execute ${detectPath}: ${reason}`)
    process.exit(1)
  })

  if (detectExitCode === undefined) {
    logger.error(`Could not determine detect exit code. Canceling policy check.`)
    process.exit(1)
  } else if (detectExitCode > 0 && detectExitCode != POLICY_SEVERITY) {
    logger.error(`Detect failed with exit code: ${detectExitCode}. Check the logs for more information.`)
    process.exit(1)
  }

  logger.info(`Detect executed successfully.`)

  let hasPolicyViolations = false

  if (SCAN_MODE === 'RAPID') {
    logger.info(`Detect executed in RAPID mode. Beginning reporting...`)

    const jsonGlobber = require('fast-glob')
    const scanJsonPaths = await jsonGlobber(`${outputPath}/*.json`)

    const scanJsonPath = scanJsonPaths[0]
    const rawdata = fs.readFileSync(scanJsonPath)
    const policyViolations = JSON.parse(rawdata.toString()) as IRapidScanResults[]

    hasPolicyViolations = policyViolations.length > 0
    logger.debug(`Policy Violations Present: ${hasPolicyViolations}`)

    const failureConditionsMet = detectExitCode === POLICY_SEVERITY || FAIL_ON_ALL
    const rapidScanReport = await createRapidScanReportString(BLACKDUCK_URL, BLACKDUCK_API_TOKEN,
        policyViolations, hasPolicyViolations && failureConditionsMet)

    if (is_merge_request) {
      logger.info('This is a merge request, commenting...')
      const message = COMMENT_PREFACE.concat('\r\n', rapidScanReport)

      const merge_request_iid = parseInt(CI_MERGE_REQUEST_IID, 10)

      const review_discussions = await gitlabGetDiscussions(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid).
        then(discussions => discussions.filter(discussion => discussion.notes![0].body.includes(COMMENT_PREFACE)))

      if (review_discussions.length > 0) {
        logger.info(`Updating existing discussion #${review_discussions[0].id} note #${review_discussions[0].notes![0].id}`)
        await gitlabUpdateNote(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid,
            parseInt(review_discussions[0].id, 10), review_discussions[0].notes![0].id, message)
      } else {
        logger.info(`Creating a new comment`)
        await gitlabCreateDiscussionWithoutPosition(CI_SERVER_URL, GITLAB_TOKEN, CI_PROJECT_ID, merge_request_iid,
            message)
      }

      logger.info('Successfully commented on PR.')
    }

    if (hasPolicyViolations) {
      if (failureConditionsMet) {
        logger.info('Components found that violate your Black Duck Policies!')
      } else {
        logger.info('No components violated your BLOCKER or CRITICAL Black Duck Policies!')
      }
    } else {
      logger.info('No components found that violate your Black Duck policies!')
    }
    logger.info('Reporting complete.')
  } else {
    logger.info(`Executed in ${SCAN_MODE} mode. Skipping policy check.`)
  }

  const diagnosticMode = process.env.DETECT_DIAGNOSTIC?.toLowerCase() === 'true'
  const extendedDiagnosticMode = process.env.DETECT_DIAGNOSTIC_EXTENDED?.toLowerCase() === 'true'
  if (diagnosticMode || extendedDiagnosticMode) {

    const diagnosticGlobber = require('fast-glob');
    const diagnosticZip = await diagnosticGlobber([`${outputPath}/runs/*.zip`]);

    fs.copyFile(diagnosticZip[0], "detect-diagnostic-logs.zip", (err) => {
      if (err) {
        logger.warn(`Unable to copy diagnostic logs to detect-diagnostic-logs.zip: ${err}`)
      }
    })
  }

  if (hasPolicyViolations) {
    logger.warn('Found dependencies violating policy!')
  } else if (detectExitCode > 0) {
    logger.warn('Dependency check failed! See Detect output for more information.')
  } else if (detectExitCode === SUCCESS) {
    logger.info('None of your dependencies violate your Black Duck policies!')
  }
}

main()