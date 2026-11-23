// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title DemoToken
 * @notice Mock ERC-20 with 18 decimals for test environments.
 *         Minting is restricted to the contract owner / authorized demo operator.
 */
contract DemoToken is ERC20, Ownable {
    constructor() ERC20("DemoToken", "DEMO") Ownable(msg.sender) {}

    /// @notice Mint `amount` tokens to `to`. Restricted to authorized demo operator.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
