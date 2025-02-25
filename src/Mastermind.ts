import {
  Field,
  SmartContract,
  state,
  State,
  method,
  Poseidon,
  AccountUpdate,
  UInt64,
  PublicKey,
  UInt32,
  Permissions,
  Provable,
} from 'o1js';

import {
  checkIfSolved,
  compressRewardAndFinalizeSlot,
  compressTurnCountMaxAttemptSolved,
  deserializeClue,
  getClueFromGuess,
  separateCombinationDigits,
  separateRewardAndFinalizeSlot,
  separateTurnCountAndMaxAttemptSolved,
  serializeClue,
  validateCombination,
} from './utils.js';
import { StepProgramProof } from './stepProgram.js';

export const GAME_DURATION = 10; // 10 slots

export class MastermindZkApp extends SmartContract {
  /**
   * `turnCountMaxAttemptsIsSolved` is a compressed state variable that
   * stores the current turn count, maximum number of attempts allowed, and whether the game has been solved.
   * Uses `compressTurnCountMaxAttemptSolved` to compress the state variable.
   * The state variable is decompressed using `separateTurnCountAndMaxAttemptSolved`.
   */
  @state(Field) turnCountMaxAttemptsIsSolved = State<Field>();

  /**
   * `codeMasterId` is the ID of the codeMaster `Hash(PubKey)` who created the game.
   */
  @state(Field) codeMasterId = State<Field>();

  /**
   * `codeBreakerId` is the ID of the codeBreaker `Hash(PubKey)` who accepted the game.
   */
  @state(Field) codeBreakerId = State<Field>();

  /**
   * `refereeId` is the ID of the referee `Hash(PubKey)` who penalizes misbehaving players.
   */
  @state(Field) refereeId = State<Field>();

  /**
   * `solutionHash` is the hash of the secret combination and salt.
   */
  @state(Field) solutionHash = State<Field>();

  /**
   * `unseparatedGuess` is the last guess made by the codeBreaker.
   */
  @state(Field) unseparatedGuess = State<Field>();

  /**
   * `serializedClue` is the serialized clue given by the codeMaster to the codeBreaker.
   */
  @state(Field) serializedClue = State<Field>();

  /**
   * `rewardFinalizeSlot` is a compressed state variable that stores the reward amount(`UInt64`) and the slot(`UInt32`) when the game is finalized.
   * Uses `compressRewardAndFinalizeSlot` to compress the state variable.
   * The state variable is decompressed using `separateRewardAndFinalizeSlot`.
   */
  @state(Field) rewardFinalizeSlot = State<Field>();

  /**
   * Asserts that the game has been finalized. For internal use only.
   */
  async assertFinalized() {
    const { finalizeSlot } = separateRewardAndFinalizeSlot(
      this.rewardFinalizeSlot.getAndRequireEquals()
    );
    this.network.globalSlotSinceGenesis
      .getAndRequireEquals()
      .assertGreaterThanOrEqual(
        finalizeSlot,
        'The game has not been finalized yet!'
      );
  }

  /**
   * Asserts that the game is still ongoing. For internal use only.
   */
  async assertNotFinalized() {
    const { finalizeSlot } = separateRewardAndFinalizeSlot(
      this.rewardFinalizeSlot.getAndRequireEquals()
    );
    this.network.globalSlotSinceGenesis
      .getAndRequireEquals()
      .assertLessThan(finalizeSlot, 'The game has already been finalized!');
  }

  async deploy() {
    await super.deploy();

    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey:
        Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
      send: Permissions.proof(),
    });
  }

  /**
   * Initializes the game by setting the maximum number of attempts allowed. All other state variables are set to 0.
   * @param maxAttempts The maximum number of total turns allowed for the game.
   * @param refereePubKey The public key of the referee who will penalize misbehaving players.
   */
  @method async initGame(maxAttempts: Field, refereePubKey: PublicKey) {
    const isInitialized = this.account.provedState.getAndRequireEquals();
    isInitialized.assertFalse('The game has already been initialized!');

    // Sets your entire state to 0.
    super.init();

    maxAttempts.assertGreaterThanOrEqual(
      Field.from(5),
      'The minimum number of attempts allowed is 5!'
    );

    maxAttempts.assertLessThanOrEqual(
      Field.from(15),
      'The maximum number of attempts allowed is 15!'
    );

    const turnCountMaxAttemptsIsSolved = compressTurnCountMaxAttemptSolved([
      Field.from(0),
      maxAttempts,
      Field.from(0),
    ]);

    this.turnCountMaxAttemptsIsSolved.set(turnCountMaxAttemptsIsSolved);

    const refereeId = Poseidon.hash(refereePubKey.toFields());
    this.refereeId.set(refereeId);
  }

  /**
   * Creates a new game by setting the secret combination and salt.
   * @param unseparatedSecretCombination The secret combination to be solved by the codeBreaker.
   * @param salt The salt to be used in the hash function to prevent pre-image attacks.
   * @param rewardAmount The amount of tokens to be rewarded to the codeBreaker upon solving the game.
   * @throws If the game has not been initialized yet, or if the game has already been created.
   */
  @method async createGame(
    unseparatedSecretCombination: Field,
    salt: Field,
    rewardAmount: UInt64
  ) {
    const isInitialized = this.account.provedState.getAndRequireEquals();
    isInitialized.assertTrue('The game has not been initialized yet!');

    const [turnCount, maxAttempts, isSolved] =
      separateTurnCountAndMaxAttemptSolved(
        this.turnCountMaxAttemptsIsSolved.getAndRequireEquals()
      );

    //! Restrict this method to be only called once at the beginning of a game
    turnCount.assertEquals(0, 'A mastermind game is already created!');

    //! Separate combination digits and validate
    const secretCombination = separateCombinationDigits(
      unseparatedSecretCombination
    );

    validateCombination(secretCombination);

    // Generate solution hash & store on-chain
    const solutionHash = Poseidon.hash([...secretCombination, salt]);
    this.solutionHash.set(solutionHash);

    // Generate codeMaster ID
    const codeMasterId = Poseidon.hash(
      this.sender.getAndRequireSignature().toFields()
    );

    // Store codeMaster ID on-chain
    this.codeMasterId.set(codeMasterId);

    // Increment on-chain turnCount
    const updatedTurnCountMaxAttemptsIsSolved =
      compressTurnCountMaxAttemptSolved([
        turnCount.add(1),
        maxAttempts,
        isSolved,
      ]);
    this.turnCountMaxAttemptsIsSolved.set(updatedTurnCountMaxAttemptsIsSolved);

    // Get the reward amount from the codeMaster
    const codeMasterUpdate = AccountUpdate.createSigned(
      this.sender.getAndRequireSignature()
    );
    codeMasterUpdate.send({ to: this.address, amount: rewardAmount });

    // Update the on-chain reward amount
    this.rewardFinalizeSlot.set(
      compressRewardAndFinalizeSlot(rewardAmount, UInt32.zero)
    );
  }

  /**
   * Codebreaker accepts the game and pays the reward to contract.
   * @throws If the game has not been initialized yet, or if the game has not been created yet.
   */
  @method async acceptGame() {
    const isInitialized = this.account.provedState.getAndRequireEquals();
    isInitialized.assertTrue('The game has not been initialized yet!');

    this.codeBreakerId
      .getAndRequireEquals()
      .assertEquals(
        Field.from(0),
        'The game has already been accepted by the codeBreaker!'
      );

    const [turnCount, ,] = separateTurnCountAndMaxAttemptSolved(
      this.turnCountMaxAttemptsIsSolved.getAndRequireEquals()
    );

    turnCount.assertEquals(1, 'The game has not been created yet!');

    // Get the reward amount from the on-chain state
    const { rewardAmount } = separateRewardAndFinalizeSlot(
      this.rewardFinalizeSlot.getAndRequireEquals()
    );

    // Transfer the reward amount to the contract from the codeBreaker
    const codeBreakerUpdate = AccountUpdate.createSigned(
      this.sender.getAndRequireSignature()
    );
    codeBreakerUpdate.send({ to: this.address, amount: rewardAmount });

    // generate codeBreaker ID and store on-chain
    const codeBreakerId = Poseidon.hash(
      this.sender.getAndRequireSignature().toFields()
    );
    this.codeBreakerId.set(codeBreakerId);

    const currentSlot =
      this.network.globalSlotSinceGenesis.getAndRequireEquals();
    // Set the finalize slot to GAME_DURATION slots after the current slot (slot time is 3 minutes)
    const finalizeSlot = currentSlot.add(UInt32.from(GAME_DURATION));
    this.rewardFinalizeSlot.set(
      compressRewardAndFinalizeSlot(rewardAmount.mul(2), finalizeSlot)
    );
  }

  /**
   * Submits a proof to on-chain that includes the all game steps and the final solution if the game is solved.
   * @param proof The proof generated by using `StepProgramProof` zkProgram.
   * @throws If the game has not been initialized or created yet, or if the game has already been solved.
   */
  @method async submitGameProof(proof: StepProgramProof) {
    const isInitialized = this.account.provedState.getAndRequireEquals();
    isInitialized.assertTrue('The game has not been initialized yet!');

    const codeBreakerId = this.codeBreakerId.getAndRequireEquals();
    codeBreakerId.assertNotEquals(
      Field.from(0),
      'The game has not been accepted by the codeBreaker yet!'
    );

    await this.assertNotFinalized();

    // Check if the game has been solved
    let [turnCount, maxAttempts, isSolved] =
      separateTurnCountAndMaxAttemptSolved(
        this.turnCountMaxAttemptsIsSolved.getAndRequireEquals()
      );

    isSolved.assertEquals(0, 'The game secret has already been solved!');

    proof.verify();

    // Validate and prevent different code breaker, code master, solution hash, max attempts from on-chain state
    proof.publicOutput.codeBreakerId.assertEquals(
      codeBreakerId,
      'The code breaker ID is not same as the one stored on-chain!'
    );

    proof.publicOutput.codeMasterId.assertEquals(
      this.codeMasterId.getAndRequireEquals(),
      'The code master ID is not same as the one stored on-chain!'
    );

    proof.publicOutput.solutionHash.assertEquals(
      this.solutionHash.getAndRequireEquals(),
      'The solution hash is not same as the one stored on-chain!'
    );

    proof.publicOutput.turnCount.assertGreaterThan(
      turnCount,
      'Cannot submit a proof for a previous turn!'
    );

    const maxAttemptsExceeded = proof.publicOutput.turnCount.greaterThanOrEqual(
      maxAttempts.mul(2)
    );

    const deserializedClue = deserializeClue(proof.publicOutput.serializedClue);
    isSolved = checkIfSolved(deserializedClue)
      .and(maxAttemptsExceeded.not())
      .toField();

    this.codeBreakerId.set(proof.publicOutput.codeBreakerId);
    this.unseparatedGuess.set(proof.publicOutput.lastGuess);
    this.serializedClue.set(proof.publicOutput.serializedClue);

    const updatedTurnCountMaxAttemptsIsSolved =
      compressTurnCountMaxAttemptSolved([
        proof.publicOutput.turnCount,
        maxAttempts,
        isSolved,
      ]);

    this.turnCountMaxAttemptsIsSolved.set(updatedTurnCountMaxAttemptsIsSolved);
  }

  /**
   * Allows the winner to claim the reward.
   * @throws If the game has not been finalized yet, or if the caller is not the winner.
   */
  @method async claimReward() {
    let [, , isSolved] = separateTurnCountAndMaxAttemptSolved(
      this.turnCountMaxAttemptsIsSolved.getAndRequireEquals()
    );

    await this.assertFinalized();

    const claimer = this.sender.getAndRequireSignature();

    const codeMasterId = this.codeMasterId.getAndRequireEquals();
    const computedCodeMasterId = Poseidon.hash(claimer.toFields());

    const codeBreakerId = this.codeBreakerId.getAndRequireEquals();
    const computedCodebreakerId = Poseidon.hash(claimer.toFields());

    const isCodeMaster = codeMasterId.equals(computedCodeMasterId);
    const isCodeBreaker = codeBreakerId.equals(computedCodebreakerId);

    isCodeMaster
      .or(isCodeBreaker)
      .assertTrue('You are not the codeMaster or codeBreaker of this game!');

    const isWinner = isCodeMaster
      .and(isSolved.equals(0))
      .or(isCodeBreaker.and(isSolved.equals(1)));
    isWinner.assertTrue('You are not the winner of this game!');

    const { rewardAmount } = separateRewardAndFinalizeSlot(
      this.rewardFinalizeSlot.getAndRequireEquals()
    );
    this.send({ to: claimer, amount: rewardAmount });
  }

  /**
   * Allows the referee to penalize the codeBreaker if they have not make a guess within the time limit.
   * @throws If the the caller is not the referee.
   */
  @method async penalizeCodeBreaker(codeMasterPubKey: PublicKey) {
    const isInitialized = this.account.provedState.getAndRequireEquals();
    isInitialized.assertTrue('The game has not been initialized yet!');

    const refereeId = this.refereeId.getAndRequireEquals();
    const computedRefereeId = Poseidon.hash(
      this.sender.getAndRequireSignature().toFields()
    );

    refereeId.assertEquals(
      computedRefereeId,
      'You are not the referee of this game!'
    );

    const codeMasterId = Poseidon.hash(codeMasterPubKey.toFields());
    this.codeMasterId
      .getAndRequireEquals()
      .assertEquals(
        codeMasterId,
        'The code master ID is not same as the one stored on-chain!'
      );

    const { rewardAmount } = separateRewardAndFinalizeSlot(
      this.rewardFinalizeSlot.getAndRequireEquals()
    );
    this.send({ to: codeMasterPubKey, amount: rewardAmount });
  }

  /**
   * Allows the referee to penalize the codeMaster if they have not give clue within the time limit.
   * @throws If the the caller is not the referee.
   */
  @method async penalizeCodeMaster(codeBreakerPubKey: PublicKey) {
    const isInitialized = this.account.provedState.getAndRequireEquals();
    isInitialized.assertTrue('The game has not been initialized yet!');

    const refereeId = this.refereeId.getAndRequireEquals();
    const computedRefereeId = Poseidon.hash(
      this.sender.getAndRequireSignature().toFields()
    );

    refereeId.assertEquals(
      computedRefereeId,
      'You are not the referee of this game!'
    );

    const codeBreakerId = Poseidon.hash(codeBreakerPubKey.toFields());
    this.codeBreakerId
      .getAndRequireEquals()
      .assertEquals(
        codeBreakerId,
        'The code breaker ID is not same as the one stored on-chain!'
      );

    const { rewardAmount } = separateRewardAndFinalizeSlot(
      this.rewardFinalizeSlot.getAndRequireEquals()
    );
    this.send({ to: codeBreakerPubKey, amount: rewardAmount });
  }

  /**
   * Allows the codeBreaker to make a guess outside `stepProof` and then gives it to the codeMaster to provide a clue.
   * @param unseparatedGuess The guess combination made by the codeBreaker.
   * @throws If the game has not been initialized yet, or if the game has already been finalized.
   */
  @method async makeGuess(unseparatedGuess: Field) {
    const isInitialized = this.account.provedState.getAndRequireEquals();
    isInitialized.assertTrue('The game has not been initialized yet!');

    await this.assertNotFinalized();

    const [turnCount, maxAttempts, isSolved] =
      separateTurnCountAndMaxAttemptSolved(
        this.turnCountMaxAttemptsIsSolved.getAndRequireEquals()
      );

    //! Assert that the secret combination is not solved yet
    isSolved.assertEquals(0, 'The game secret has already been solved!');

    //! Only allow codeBreaker to call this method following the correct turn sequence
    const isCodebreakerTurn = turnCount.isEven().not();
    isCodebreakerTurn.assertTrue(
      'Please wait for the codeMaster to give you a clue!'
    );

    //! Assert that the codeBreaker has not reached the limit number of attempts
    turnCount.assertLessThan(
      maxAttempts.mul(2),
      'You have reached the number limit of attempts to solve the secret combination!'
    );

    // Generate an ID for the caller
    const computedCodebreakerId = Poseidon.hash(
      this.sender.getAndRequireSignature().toFields()
    );

    const setCodeBreakerId = () => {
      this.codeBreakerId.set(computedCodebreakerId);
      return computedCodebreakerId;
    };

    //? If first guess ==> set the codeBreaker ID
    //? Else           ==> fetch the codeBreaker ID
    const isFirstGuess = turnCount.equals(1);
    const codeBreakerId = Provable.if(
      isFirstGuess,
      setCodeBreakerId(),
      this.codeBreakerId.getAndRequireEquals()
    );

    //! Restrict method access solely to the correct codeBreaker
    computedCodebreakerId.assertEquals(
      codeBreakerId,
      'You are not the codeBreaker of this game!'
    );

    //! Separate and validate the guess combination
    const guessDigits = separateCombinationDigits(unseparatedGuess);
    validateCombination(guessDigits);

    // Update the on-chain unseparated guess
    this.unseparatedGuess.set(unseparatedGuess);

    // Increment turnCount and wait for the codeMaster to give a clue
    const updatedTurnCountMaxAttemptsIsSolved =
      compressTurnCountMaxAttemptSolved([
        turnCount.add(1),
        maxAttempts,
        isSolved,
      ]);

    this.turnCountMaxAttemptsIsSolved.set(updatedTurnCountMaxAttemptsIsSolved);
  }

  /**
   * Allows the codeMaster to give a clue to the codeBreaker outside `stepProof`.
   * @param unseparatedSecretCombination The secret combination to be solved by the codeBreaker.
   * @param salt The salt to be used in the hash function to prevent pre-image attacks.
   * @throws If the game has not been initialized yet, or if the game has already been finalized.
   */
  @method async giveClue(unseparatedSecretCombination: Field, salt: Field) {
    const isInitialized = this.account.provedState.getAndRequireEquals();
    isInitialized.assertTrue('The game has not been initialized yet!');

    await this.assertNotFinalized();

    const [turnCount, maxAttempts, isSolved] =
      separateTurnCountAndMaxAttemptSolved(
        this.turnCountMaxAttemptsIsSolved.getAndRequireEquals()
      );

    // Generate codeMaster ID
    const computedCodemasterId = Poseidon.hash(
      this.sender.getAndRequireSignature().toFields()
    );

    //! Restrict method access solely to the correct codeMaster
    this.codeMasterId
      .getAndRequireEquals()
      .assertEquals(
        computedCodemasterId,
        'Only the codeMaster of this game is allowed to give clue!'
      );

    //! Assert that the codeBreaker has not reached the limit number of attempts
    turnCount.assertLessThanOrEqual(
      maxAttempts.mul(2),
      'The codeBreaker has finished the number of attempts without solving the secret combination!'
    );

    //! Assert that the secret combination is not solved yet
    isSolved.assertEquals(
      0,
      'The codeBreaker has already solved the secret combination!'
    );

    //! Assert that the turnCount is pair & not zero for the codeMaster to call this method
    const isNotFirstTurn = turnCount.equals(0).not();
    const isCodemasterTurn = turnCount.isEven().and(isNotFirstTurn);
    isCodemasterTurn.assertTrue(
      'Please wait for the codeBreaker to make a guess!'
    );

    // Separate the secret combination digits
    const solution = separateCombinationDigits(unseparatedSecretCombination);

    //! Compute solution hash and assert integrity to state on-chain
    const computedSolutionHash = Poseidon.hash([...solution, salt]);
    this.solutionHash
      .getAndRequireEquals()
      .assertEquals(
        computedSolutionHash,
        'The secret combination is not compliant with the stored hash on-chain!'
      );

    // Fetch & separate the on-chain guess
    const unseparatedGuess = this.unseparatedGuess.getAndRequireEquals();
    const guessDigits = separateCombinationDigits(unseparatedGuess);

    // Scan the guess through the solution and return clue result(hit or blow)
    let clue = getClueFromGuess(guessDigits, solution);

    // Serialize & update the on-chain clue
    const serializedClue = serializeClue(clue);
    this.serializedClue.set(serializedClue);

    // Check if the guess is correct & update the on-chain state
    let isSolvedThisTurn = checkIfSolved(clue).toField();
    // Increment the on-chain turnCount and update the isSolved state
    const updatedTurnCountMaxAttemptsIsSolved =
      compressTurnCountMaxAttemptSolved([
        turnCount.add(1),
        maxAttempts,
        isSolvedThisTurn,
      ]);

    this.turnCountMaxAttemptsIsSolved.set(updatedTurnCountMaxAttemptsIsSolved);
  }
}
