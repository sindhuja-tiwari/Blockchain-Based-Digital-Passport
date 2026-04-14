const { ethers } = require("hardhat");
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("PassportRegistry", function () {
  let registry, factory, gateway;
  let owner, issuer, verifier, revoker, borderAgent, holder, stranger;

  const PP = "PP-000001";
  const BIOMETRIC = ethers.keccak256(ethers.toUtf8Bytes("Priya|Nair|1992-07-14|IND"));
  const DATA_HASH = ethers.keccak256(ethers.toUtf8Bytes("full-data-payload"));

  const PassportStatus = { Active: 0, Revoked: 1, Expired: 2, Suspended: 3, Lost: 4 };
  const PassportType   = { Regular: 0, Diplomatic: 1, Service: 2, Official: 3, Emergency: 4 };
  const VisaType       = { Tourist: 0, Business: 1, Student: 2, Work: 3, Transit: 4, Diplomatic: 5 };
  const AlertLevel     = { None: 0, Watch: 1, Detain: 2, Arrest: 3 };

  beforeEach(async () => {
    [owner, issuer, verifier, revoker, borderAgent, holder, stranger] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("PassportRegistry");
    registry = await Registry.deploy(owner.address);

    // Grant roles
    await registry.grantRole(await registry.ISSUER_ROLE(),       issuer.address);
    await registry.grantRole(await registry.VERIFIER_ROLE(),     verifier.address);
    await registry.grantRole(await registry.REVOKER_ROLE(),      revoker.address);
    await registry.grantRole(await registry.BORDER_AGENT_ROLE(), borderAgent.address);

    // Deploy BorderGateway
    const Gateway = await ethers.getContractFactory("BorderGateway");
    gateway = await Gateway.deploy(await registry.getAddress());
    await registry.grantRole(await registry.BORDER_AGENT_ROLE(), await gateway.getAddress());
  });

  // ── Helpers ──────────────────────────────────────
  async function issueDefault(pid = PP, holderAddr = ethers.ZeroAddress) {
    return registry.connect(issuer).issuePassport(
      pid, BIOMETRIC, DATA_HASH, "IND", PassportType.Regular, 10, holderAddr
    );
  }

  // ─────────────────────────────────────────────────
  describe("Passport Issuance", () => {
    it("issues a passport and emits event", async () => {
      await expect(issueDefault())
        .to.emit(registry, "PassportIssued")
        .withArgs(PP, "IND", PassportType.Regular, BIOMETRIC, issuer.address, anyValue);
    });

    it("reverts on duplicate passport ID", async () => {
      await issueDefault();
      await expect(issueDefault()).to.be.revertedWithCustomError(registry, "PassportAlreadyExists");
    });

    it("reverts on duplicate biometric hash", async () => {
      await issueDefault();
      await expect(issueDefault("PP-000002")).to.be.revertedWithCustomError(registry, "BiometricAlreadyRegistered");
    });

    it("binds holder wallet and emits HolderWalletBound", async () => {
      await expect(issueDefault(PP, holder.address))
        .to.emit(registry, "HolderWalletBound")
        .withArgs(PP, holder.address);

      expect(await registry.getPassportByWallet(holder.address)).to.equal(PP);
    });

    it("reverts on wallet already bound to another passport", async () => {
      await issueDefault(PP, holder.address);
      const bio2 = ethers.keccak256(ethers.toUtf8Bytes("other-bio"));
      await expect(
        registry.connect(issuer).issuePassport("PP-000002", bio2, DATA_HASH, "IND", 0, 10, holder.address)
      ).to.be.revertedWithCustomError(registry, "WalletAlreadyBound");
    });

    it("only ISSUER_ROLE can issue", async () => {
      await expect(issueDefault(PP)).connect(stranger)
        .to.be.reverted;
    });
  });

  // ─────────────────────────────────────────────────
  describe("Passport Status", () => {
    beforeEach(async () => { await issueDefault(); });

    it("returns Active and valid after issue", async () => {
      const [status, alert, , isValid] = await registry.getPassportStatus(PP);
      expect(status).to.equal(PassportStatus.Active);
      expect(isValid).to.be.true;
      expect(alert).to.equal(AlertLevel.None);
    });

    it("shows expired after validity window", async () => {
      await time.increase(11 * 365 * 24 * 3600);
      const [, , , isValid] = await registry.getPassportStatus(PP);
      expect(isValid).to.be.false;
    });

    it("reverts getPassportStatus for unknown ID", async () => {
      await expect(registry.getPassportStatus("PP-UNKNOWN"))
        .to.be.revertedWithCustomError(registry, "PassportNotFound");
    });
  });

  // ─────────────────────────────────────────────────
  describe("Renewal", () => {
    beforeEach(async () => { await issueDefault(); });

    it("renews and emits event", async () => {
      const newHash = ethers.keccak256(ethers.toUtf8Bytes("updated-data"));
      await expect(registry.connect(issuer).renewPassport(PP, newHash, 5))
        .to.emit(registry, "PassportRenewed");
    });

    it("renews an expired passport back to Active", async () => {
      await time.increase(11 * 365 * 24 * 3600);
      const newHash = ethers.keccak256(ethers.toUtf8Bytes("new-data"));
      await registry.connect(issuer).renewPassport(PP, newHash, 10);
      const [status, , , isValid] = await registry.getPassportStatus(PP);
      expect(status).to.equal(PassportStatus.Active);
      expect(isValid).to.be.true;
    });
  });

  // ─────────────────────────────────────────────────
  describe("Revocation", () => {
    beforeEach(async () => { await issueDefault(); });

    it("single-authority revoke works", async () => {
      await expect(registry.connect(revoker).revokePassport(PP, "Lost"))
        .to.emit(registry, "PassportStatusChanged")
        .withArgs(PP, PassportStatus.Active, PassportStatus.Revoked, "Lost", revoker.address);

      const [status, , , isValid] = await registry.getPassportStatus(PP);
      expect(status).to.equal(PassportStatus.Revoked);
      expect(isValid).to.be.false;
    });

    it("suspension and reinstatement cycle", async () => {
      await registry.connect(revoker).suspendPassport(PP, "Under review");
      let [status] = await registry.getPassportStatus(PP);
      expect(status).to.equal(PassportStatus.Suspended);

      await registry.connect(issuer).reinstatePassport(PP);
      [status] = await registry.getPassportStatus(PP);
      expect(status).to.equal(PassportStatus.Active);
    });

    it("mark as lost", async () => {
      await registry.connect(revoker).markLost(PP, "Reported stolen");
      const [status] = await registry.getPassportStatus(PP);
      expect(status).to.equal(PassportStatus.Lost);
    });
  });

  // ─────────────────────────────────────────────────
  describe("Multi-sig Revocation", () => {
    let revoker2, revoker3;

    beforeEach(async () => {
      [,,,,,,,revoker2, revoker3] = await ethers.getSigners();
      await registry.grantRole(await registry.REVOKER_ROLE(), revoker2.address);
      await registry.grantRole(await registry.REVOKER_ROLE(), revoker3.address);
      await registry.setMultiSigThreshold(2);
      await issueDefault();
    });

    it("requires threshold votes to execute", async () => {
      // Propose (auto-votes for proposer = 1 vote)
      await registry.connect(revoker).proposeRevocation(PP, "Fraud suspected");
      let [status] = await registry.getPassportStatus(PP);
      expect(status).to.equal(PassportStatus.Active); // not yet revoked

      // Second vote → threshold met → execute
      await expect(registry.connect(revoker2).voteRevocation(PP))
        .to.emit(registry, "RevocationExecuted")
        .withArgs(PP, "Fraud suspected");

      [status] = await registry.getPassportStatus(PP);
      expect(status).to.equal(PassportStatus.Revoked);
    });

    it("prevents double voting", async () => {
      await registry.connect(revoker).proposeRevocation(PP, "Test");
      await expect(registry.connect(revoker).voteRevocation(PP))
        .to.be.revertedWithCustomError(registry, "AlreadyVoted");
    });
  });

  // ─────────────────────────────────────────────────
  describe("Alerts", () => {
    beforeEach(async () => { await issueDefault(); });

    it("raises and clears alerts", async () => {
      await expect(registry.connect(borderAgent).raiseAlert(PP, AlertLevel.Watch, "Suspicious activity"))
        .to.emit(registry, "AlertRaised");

      let [, alert] = await registry.getPassportStatus(PP);
      expect(alert).to.equal(AlertLevel.Watch);

      await expect(registry.connect(revoker).clearAlert(PP))
        .to.emit(registry, "AlertCleared");

      [, alert] = await registry.getPassportStatus(PP);
      expect(alert).to.equal(AlertLevel.None);
    });
  });

  // ─────────────────────────────────────────────────
  describe("Visa Management", () => {
    let visaId;
    const now = () => Math.floor(Date.now() / 1000);

    beforeEach(async () => {
      await issueDefault();
      const validFrom  = now() + 100;
      const validUntil = now() + 365 * 24 * 3600;
      const tx = await registry.connect(verifier).issueVisa(
        PP, "USA", VisaType.Tourist, validFrom, validUntil, 2, "No work"
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => l.fragment?.name === "VisaIssued");
      visaId = event.args.visaId;
    });

    it("issues a visa and increments count", async () => {
      const passport = await registry.connect(verifier).getPassport(PP);
      expect(passport.visaCount).to.equal(1);
    });

    it("retrieves visa IDs for passport", async () => {
      const ids = await registry.connect(verifier).getPassportVisas(PP);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.equal(visaId);
    });

    it("revokes a visa", async () => {
      await expect(registry.connect(revoker).revokeVisa(visaId))
        .to.emit(registry, "VisaRevoked");
      const visa = await registry.connect(verifier).getVisa(visaId);
      expect(visa.isValid).to.be.false;
    });

    it("tracks used entries on useVisaEntry", async () => {
      await time.increase(200); // move past validFrom
      await registry.connect(borderAgent).useVisaEntry(visaId);
      const visa = await registry.connect(verifier).getVisa(visaId);
      expect(visa.usedEntries).to.equal(1);
    });

    it("reverts when entry limit reached", async () => {
      await time.increase(200);
      await registry.connect(borderAgent).useVisaEntry(visaId);
      await registry.connect(borderAgent).useVisaEntry(visaId);
      await expect(registry.connect(borderAgent).useVisaEntry(visaId))
        .to.be.revertedWithCustomError(registry, "VisaEntryLimitReached");
    });
  });

  // ─────────────────────────────────────────────────
  describe("Border Crossings", () => {
    beforeEach(async () => { await issueDefault(); });

    it("records a crossing and increments count", async () => {
      await expect(
        registry.connect(borderAgent).recordCrossing(PP, "IND", "USA", true, "JFK Airport")
      ).to.emit(registry, "BorderCrossingRecorded");

      const passport = await registry.connect(verifier).getPassport(PP);
      expect(passport.crossingCount).to.equal(1);
    });

    it("reverts crossing for detained passport", async () => {
      await registry.connect(borderAgent).raiseAlert(PP, AlertLevel.Detain, "Security hold");
      await expect(
        registry.connect(borderAgent).recordCrossing(PP, "IND", "USA", true, "JFK")
      ).to.be.reverted;
    });

    it("retrieves travel history", async () => {
      await registry.connect(borderAgent).recordCrossing(PP, "IND", "UAE", true, "DXB");
      await registry.connect(borderAgent).recordCrossing(PP, "UAE", "GBR", true, "LHR");
      const history = await registry.connect(verifier).getTravelHistory(PP);
      expect(history.length).to.equal(2);
    });
  });

  // ─────────────────────────────────────────────────
  describe("BorderGateway", () => {
    it("clears a traveller with valid passport and bound wallet", async () => {
      await issueDefault(PP, holder.address);
      const tx = await gateway.connect(holder).processCrossing("IND", "SGP", "Changi Airport");
      await expect(tx).to.emit(gateway, "TravellerCleared");
    });

    it("denies a revoked passport at the gateway", async () => {
      await issueDefault(PP, holder.address);
      await registry.connect(revoker).revokePassport(PP, "Test");
      const tx = await gateway.connect(holder).processCrossing("IND", "SGP", "Changi");
      await expect(tx).to.emit(gateway, "TravellerDenied");
    });

    it("reverts when no passport bound to wallet", async () => {
      await expect(gateway.connect(stranger).processCrossing("IND", "USA", "JFK"))
        .to.be.revertedWith("No passport bound to this wallet");
    });
  });

  // ─────────────────────────────────────────────────
  describe("PassportFactory", () => {
    it("deploys a registry per country", async () => {
      const Factory = await ethers.getContractFactory("PassportFactory");
      const fac = await Factory.deploy();
      await fac.deployRegistry("IND", "Ministry of External Affairs", owner.address);
      await fac.deployRegistry("USA", "Department of State", owner.address);
      expect(await fac.totalDeployed()).to.equal(2);
    });

    it("reverts on duplicate country", async () => {
      const Factory = await ethers.getContractFactory("PassportFactory");
      const fac = await Factory.deploy();
      await fac.deployRegistry("IND", "MEA", owner.address);
      await expect(fac.deployRegistry("IND", "MEA", owner.address)).to.be.reverted;
    });
  });

  // ─────────────────────────────────────────────────
  describe("Stats & Enumeration", () => {
    it("returns correct stats", async () => {
      await issueDefault();
      const [total, visas, crossings] = await registry.getStats();
      expect(total).to.equal(1);
      expect(visas).to.equal(0);
      expect(crossings).to.equal(0);
    });

    it("paginates passport IDs", async () => {
      const bio2 = ethers.keccak256(ethers.toUtf8Bytes("other-bio-2"));
      await issueDefault();
      await registry.connect(issuer).issuePassport("PP-000002", bio2, DATA_HASH, "GBR", 0, 10, ethers.ZeroAddress);
      const ids = await registry.connect(verifier).getPassportIds(0, 10);
      expect(ids.length).to.equal(2);
    });
  });

  // ─────────────────────────────────────────────────
  describe("Pause", () => {
    it("blocks issuance when paused", async () => {
      await registry.pause();
      await expect(issueDefault()).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });

    it("resumes after unpause", async () => {
      await registry.pause();
      await registry.unpause();
      await expect(issueDefault()).to.emit(registry, "PassportIssued");
    });
  });
});

function anyValue() { return true; } // chai matcher helper