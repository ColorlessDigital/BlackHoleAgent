/**
 * Agent State Machine Phases
 * @enum {string}
 */
export const AgentState = {
  PLAN: 'PLAN',
  ACT: 'ACT',
  OBSERVE: 'OBSERVE',
  VERIFY: 'VERIFY',
  REPAIR: 'REPAIR',
  SUMMARIZE: 'SUMMARIZE',
  FAIL: 'FAIL',
  STOPPED: 'STOPPED'
};

/**
 * Standard event structure for the Agent Run Timeline
 * @typedef {Object} AgentEvent
 * @property {string} type - Event type (e.g. 'state_change', 'tool_start', 'tool_end', 'verification_start', 'verification_end')
 * @property {string} state - Current AgentState
 * @property {Object} payload - Additional event-specific details
 * @property {number} timestamp - Epoch timestamp in milliseconds
 */

/**
 * Long-term task checkpoint schema
 * @typedef {Object} AgentCheckpoint
 * @property {string} userGoal - Original user goal / instruction
 * @property {string[]} planSteps - Structured plan steps
 * @property {number} currentStepIndex - Index of current step in planSteps
 * @property {string[]} completedSteps - Completed step descriptions
 * @property {string[]} pendingSteps - Steps remaining to be done
 * @property {string[]} changedFiles - Files modified in this session
 * @property {Object[]} failedVerifications - List of verification failure reports
 * @property {Object[]} toolFailures - List of failed tool calls that need correction
 * @property {Object[]} loopGuardEvents - Repeated no-progress tool call patterns detected during the session
 * @property {Object} taskGraph - Structured task graph for long-running agent work
 * @property {string} nextRecommendedAction - Recommendation for next action
 * @property {number} cycleCount - Current self-healing / loop cycle count
 */
