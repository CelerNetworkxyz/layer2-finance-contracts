import { expect } from 'chai';
import { ethers, network } from 'hardhat';

import { getAddress } from '@ethersproject/address';
import { formatUnits, parseEther, parseUnits } from '@ethersproject/units';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import { ERC20 } from '../../typechain/ERC20.d';
import { ERC20__factory } from '../../typechain/factories/ERC20__factory';
import { StrategyAaveLendingPoolV2__factory } from '../../typechain/factories/StrategyAaveLendingPoolV2__factory';
import { StrategyAaveLendingPoolV2 } from '../../typechain/StrategyAaveLendingPoolV2';
import { ensureBalanceAndApproval, getDeployerSigner } from '../common';

interface DeployStrategyAaveLendingPoolV2Info {
  strategy: StrategyAaveLendingPoolV2;
  supplyToken: ERC20;
  deployerSigner: SignerWithAddress;
}

async function deployStrategyAaveLendingPoolV2(
  deployedAddress: string | undefined,
  supplyTokenSymbol: string,
  supplyTokenAddress: string,
  aaveSupplyTokenAddress: string
): Promise<DeployStrategyAaveLendingPoolV2Info> {
  const deployerSigner = await getDeployerSigner();

  let strategy: StrategyAaveLendingPoolV2;
  if (deployedAddress) {
    strategy = StrategyAaveLendingPoolV2__factory.connect(deployedAddress, deployerSigner);
  } else {
    const strategyAaveLendingPoolV2Factory = (await ethers.getContractFactory(
      'StrategyAaveLendingPoolV2'
    )) as StrategyAaveLendingPoolV2__factory;
    strategy = await strategyAaveLendingPoolV2Factory
      .connect(deployerSigner)
      .deploy(
        process.env.AAVE_LENDING_POOL as string,
        supplyTokenSymbol,
        supplyTokenAddress,
        aaveSupplyTokenAddress,
        deployerSigner.address,
        process.env.AAVE_INCENTIVES_CONTROLLER as string,
        process.env.AAVE_STAKED_AAVE as string,
        process.env.AAVE_AAVE as string,
        process.env.UNISWAP_ROUTER as string,
        process.env.WETH as string
      );
    await strategy.deployed();
  }

  const supplyToken = ERC20__factory.connect(supplyTokenAddress, deployerSigner);

  return { strategy, supplyToken, deployerSigner };
}

export async function testStrategyAaveLendingPoolV2(
  context: Mocha.Context,
  deployedAddress: string | undefined,
  supplyTokenSymbol: string,
  supplyTokenDecimals: number,
  supplyTokenAddress: string,
  aaveSupplyTokenAddress: string,
  supplyTokenFunder: string
): Promise<void> {
  context.timeout(300000);

  const { strategy, supplyToken, deployerSigner } = await deployStrategyAaveLendingPoolV2(
    deployedAddress,
    supplyTokenSymbol,
    supplyTokenAddress,
    aaveSupplyTokenAddress
  );

  expect(getAddress(await strategy.getAssetAddress())).to.equal(getAddress(supplyToken.address));

  const strategyBalanceBeforeCommit = await strategy.syncBalance();
  console.log(
    `Strategy ${supplyTokenSymbol} balance before commit:`,
    formatUnits(strategyBalanceBeforeCommit, supplyTokenDecimals)
  );

  const displayCommitAmount = '100';
  const commitAmount = parseUnits(displayCommitAmount, supplyTokenDecimals);
  await ensureBalanceAndApproval(
    supplyToken,
    supplyTokenSymbol,
    commitAmount,
    deployerSigner,
    strategy.address,
    supplyTokenFunder
  );
  const controllerBalanceBeforeCommit = await supplyToken.balanceOf(deployerSigner.address);
  console.log(
    `Controller ${supplyTokenSymbol} balance before commit:`,
    formatUnits(controllerBalanceBeforeCommit, supplyTokenDecimals)
  );

  console.log(`===== Commit ${displayCommitAmount} ${supplyTokenSymbol} =====`);
  const commitGas = await strategy.estimateGas.aggregateCommit(commitAmount);
  expect(commitGas.lte(500000)).to.be.true;
  const commitTx = await strategy.aggregateCommit(commitAmount, { gasLimit: 500000 });
  await commitTx.wait();

  const strategyBalanceAfterCommit = await strategy.syncBalance();
  expect(strategyBalanceAfterCommit.sub(strategyBalanceBeforeCommit).gte(commitAmount)).to.be.true;
  console.log(
    `Strategy ${supplyTokenSymbol} balance after commit:`,
    formatUnits(strategyBalanceAfterCommit, supplyTokenDecimals)
  );

  const controllerBalanceAfterCommit = await supplyToken.balanceOf(deployerSigner.address);
  expect(controllerBalanceBeforeCommit.sub(controllerBalanceAfterCommit).eq(commitAmount)).to.be.true;
  console.log(
    `Controller ${supplyTokenSymbol} balance after commit:`,
    formatUnits(controllerBalanceAfterCommit, supplyTokenDecimals)
  );

  const displayUncommitAmount = '70';
  const uncommitAmount = parseUnits(displayUncommitAmount, supplyTokenDecimals);
  console.log(`===== Uncommit ${displayUncommitAmount} ${supplyTokenSymbol} =====`);
  const uncommitGas = await strategy.estimateGas.aggregateUncommit(uncommitAmount);
  expect(uncommitGas.lte(500000)).to.be.true;
  const uncommitTx = await strategy.aggregateUncommit(uncommitAmount, { gasLimit: 500000 });
  await uncommitTx.wait();

  const strategyBalanceAfterUncommit = await strategy.syncBalance();
  expect(strategyBalanceAfterUncommit.add(uncommitAmount).gte(strategyBalanceAfterCommit)).to.be.true;
  console.log(
    `Strategy ${supplyTokenSymbol} balance after uncommit:`,
    formatUnits(strategyBalanceAfterUncommit, supplyTokenDecimals)
  );

  const controllerBalanceAfterUncommit = await supplyToken.balanceOf(deployerSigner.address);
  expect(controllerBalanceAfterUncommit.sub(controllerBalanceAfterCommit).eq(uncommitAmount)).to.be.true;
  console.log(
    `Controller ${supplyTokenSymbol} balance after uncommit:`,
    formatUnits(controllerBalanceAfterUncommit, supplyTokenDecimals)
  );

  console.log('===== Optional harvest =====');
  try {
    // Send some AAVE to the strategy
    const aave = ERC20__factory.connect(process.env.AAVE_AAVE as string, deployerSigner);
    await network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [process.env.AAVE_AAVE_FUNDER]
    });
    await (
      await aave
        .connect(await ethers.getSigner(process.env.AAVE_AAVE_FUNDER as string))
        .transfer(strategy.address, parseEther('0.01'))
    ).wait();
    console.log('===== Sent AAVE to the strategy, harvesting =====');
    console.log(
      'Simulate the passing of 60 days to accumulate staked AAVE. First harvest tx should trigger cooldown().'
    );
    await ethers.provider.send('evm_increaseTime', [60 * 60 * 24 * 60]);
    const harvestGas = await strategy.estimateGas.harvest();
    if (harvestGas.lte(2000000)) {
      const harvestTx = await strategy.harvest({ gasLimit: 2000000 });
      let receipt = await harvestTx.wait();
      console.log('Harvest gas used:', receipt.gasUsed.toString());
      const strategyBalanceAfterHarvest = await strategy.syncBalance();
      expect(strategyBalanceAfterHarvest.gte(strategyBalanceAfterUncommit)).to.be.true;
      console.log(
        `Strategy ${supplyTokenSymbol} balance after harvest:`,
        formatUnits(strategyBalanceAfterHarvest, supplyTokenDecimals)
      );

      console.log('Simulate the passing of the 10-day cooldown period.');
      await ethers.provider.send('evm_increaseTime', [60 * 60 * 24 * 10]);
      const harvestTx2 = await strategy.harvest({ gasLimit: 2000000 });
      receipt = await harvestTx2.wait();
      console.log('Harvest gas used:', receipt.gasUsed.toString());
      const strategyBalanceAfterHarvest2 = await strategy.syncBalance();
      expect(strategyBalanceAfterHarvest2.gt(strategyBalanceAfterUncommit)).to.be.true;
      console.log(
        `Strategy ${supplyTokenSymbol} balance after harvest2:`,
        formatUnits(strategyBalanceAfterHarvest2, supplyTokenDecimals)
      );

      console.log('Simulate the passing of another 1 day.');
      await ethers.provider.send('evm_increaseTime', [60 * 60 * 24 * 1]);
      const harvestTx3 = await strategy.harvest({ gasLimit: 2000000 });
      receipt = await harvestTx3.wait();
      console.log('Harvest gas used:', receipt.gasUsed.toString());
      const strategyBalanceAfterHarvest3 = await strategy.syncBalance();
      expect(strategyBalanceAfterHarvest3.gt(strategyBalanceAfterUncommit)).to.be.true;
      console.log(
        `Strategy ${supplyTokenSymbol} balance after harvest3:`,
        formatUnits(strategyBalanceAfterHarvest3, supplyTokenDecimals)
      );
      console.log(
        'Diff',
        formatUnits(strategyBalanceAfterHarvest3.sub(strategyBalanceAfterHarvest2), supplyTokenDecimals)
      );

      console.log('Simulate the passing of another 1 day.');
      await ethers.provider.send('evm_increaseTime', [60 * 60 * 24 * 1]);
      const harvestTx4 = await strategy.harvest({ gasLimit: 2000000 });
      receipt = await harvestTx4.wait();
      console.log('Harvest gas used:', receipt.gasUsed.toString());
      const strategyBalanceAfterHarvest4 = await strategy.syncBalance();
      expect(strategyBalanceAfterHarvest4.gt(strategyBalanceAfterUncommit)).to.be.true;
      console.log(
        `Strategy ${supplyTokenSymbol} balance after harvest4:`,
        formatUnits(strategyBalanceAfterHarvest4, supplyTokenDecimals)
      );
      console.log(
        'Diff',
        formatUnits(strategyBalanceAfterHarvest4.sub(strategyBalanceAfterHarvest3), supplyTokenDecimals)
      );

      console.log('Simulate the passing of another 1 day.');
      await ethers.provider.send('evm_increaseTime', [60 * 60 * 24 * 1]);
      const harvestTx5 = await strategy.harvest({ gasLimit: 2000000 });
      receipt = await harvestTx5.wait();
      console.log('Harvest gas used:', receipt.gasUsed.toString());
      const strategyBalanceAfterHarvest5 = await strategy.syncBalance();
      expect(strategyBalanceAfterHarvest5.gt(strategyBalanceAfterUncommit)).to.be.true;
      console.log(
        `Strategy ${supplyTokenSymbol} balance after harvest5:`,
        formatUnits(strategyBalanceAfterHarvest5, supplyTokenDecimals)
      );
      console.log(
        'Diff',
        formatUnits(strategyBalanceAfterHarvest5.sub(strategyBalanceAfterHarvest4), supplyTokenDecimals)
      );

      console.log('Simulate the passing of another 1 day.');
      await ethers.provider.send('evm_increaseTime', [60 * 60 * 24 * 1]);
      const harvestTx6 = await strategy.harvest({ gasLimit: 2000000 });
      receipt = await harvestTx6.wait();
      console.log('Harvest gas used:', receipt.gasUsed.toString());
      const strategyBalanceAfterHarvest6 = await strategy.syncBalance();
      expect(strategyBalanceAfterHarvest6.gt(strategyBalanceAfterUncommit)).to.be.true;
      console.log(
        `Strategy ${supplyTokenSymbol} balance after harvest6:`,
        formatUnits(strategyBalanceAfterHarvest6, supplyTokenDecimals)
      );
      console.log(
        'Diff',
        formatUnits(strategyBalanceAfterHarvest6.sub(strategyBalanceAfterHarvest5), supplyTokenDecimals)
      );
    }
  } catch (e) {
    console.log('Cannot harvest:', e);
  }
}
